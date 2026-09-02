/**
 * Tests for the live verifier. The point of the verifier is to catch a sync
 * that *looks* successful but did not store what Canvas actually has, so every
 * test here mutates upstream after a sync and asserts the verifier notices.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMockCanvas, COOKIE } from './mock-canvas.js';
import { openDb } from '../src/db.js';
import { runSync, setCookie } from '../src/sync.js';
import { verifyLive } from '../src/verify.js';
import { CanvasSessionExpired } from '../src/canvas.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgpt-v-')), 'test.db');
const quiet = () => {};

/** Sync once against a mock, returning everything the tests need to poke at. */
async function synced(opts = {}) {
  const mock = await startMockCanvas(opts);
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });
  return { mock, db };
}

const findingsOf = (r, kind) => r.findings.filter((f) => f.kind === kind);

test('a freshly synced database verifies clean', async () => {
  const { mock, db } = await synced();
  const r = await verifyLive(db, { onProgress: quiet });
  assert.equal(r.summary.ok, true, 'no errors right after a successful sync');
  assert.equal(r.summary.errors, 0);
  assert.equal(findingsOf(r, 'missing_from_db').length, 0);
  assert.equal(findingsOf(r, 'drifted').length, 0);
  assert.ok(r.summary.courses_checked > 0, 'actually checked something');
  await mock.close();
});

test('an assignment added upstream after the sync is reported as missing from the db', async () => {
  const byCourse = { 1: [{ id: 1001, name: 'Original', due_at: '2026-10-01T03:59:00Z', points_possible: 100, published: true, submission_types: ['online_upload'] }] };
  const mock = await startMockCanvas({ assignmentsByCourse: byCourse });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  assert.equal((await verifyLive(db, { onProgress: quiet })).summary.ok, true, 'clean before the change');

  // Canvas gains an assignment; the database has not been told.
  byCourse[1].push({ id: 1002, name: 'Brand new homework', due_at: '2026-11-01T03:59:00Z', points_possible: 50, published: true, submission_types: ['online_upload'] });

  const r = await verifyLive(db, { entities: ['assignments'], onProgress: quiet });
  assert.equal(r.summary.ok, false, 'verifier must not pass while Canvas has data we do not');
  const missing = findingsOf(r, 'missing_from_db');
  assert.equal(missing.length, 1);
  assert.match(missing[0].detail, /Brand new homework/);

  // And a sync fixes it — proving the verifier tracks reality, not a fixed answer.
  await runSync(db, { log: quiet });
  const after = await verifyLive(db, { entities: ['assignments'], onProgress: quiet });
  assert.equal(after.summary.ok, true, 'clean once the sync has run');
  await mock.close();
});

test('an edited due date upstream is reported as drift, with both values', async () => {
  const byCourse = { 1: [{ id: 1001, name: 'Essay', due_at: '2026-10-01T03:59:00Z', points_possible: 100, published: true, submission_types: ['online_upload'] }] };
  const mock = await startMockCanvas({ assignmentsByCourse: byCourse });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  byCourse[1][0].due_at = '2026-12-25T03:59:00Z';   // professor moves the deadline

  const r = await verifyLive(db, { entities: ['assignments'], onProgress: quiet });
  const drift = findingsOf(r, 'drifted');
  assert.equal(drift.length, 1, 'the moved deadline is caught');
  assert.match(drift[0].detail, /2026-12-25/, 'reports what Canvas says');
  assert.match(drift[0].detail, /2026-10-01/, 'and what we stored');
  assert.equal(r.summary.ok, false);
  await mock.close();
});

test('an assignment deleted upstream is a warning, not an error', async () => {
  const byCourse = { 1: [
    { id: 1001, name: 'Keep', due_at: '2026-10-01T03:59:00Z', points_possible: 100, published: true, submission_types: ['online_upload'] },
    { id: 1002, name: 'Doomed', due_at: '2026-10-02T03:59:00Z', points_possible: 100, published: true, submission_types: ['online_upload'] },
  ] };
  const mock = await startMockCanvas({ assignmentsByCourse: byCourse });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  byCourse[1].pop();   // removed from Canvas, still in our database until next sync

  const r = await verifyLive(db, { entities: ['assignments'], onProgress: quiet });
  const stale = findingsOf(r, 'stale_in_db');
  assert.equal(stale.length, 1);
  assert.match(stale[0].detail, /Doomed/);
  assert.equal(stale[0].severity, 'warn', 'a pending deletion is not a data-loss bug');
  assert.equal(r.summary.errors, 0, 'and does not fail the run');
  await mock.close();
});

test('a locked resource is reported as unreadable, never as missing data', async () => {
  const { mock, db } = await synced({ lockedCourses: { 2: ['files'] }, missingCourses: { 3: ['quizzes'] } });
  const r = await verifyLive(db, { entities: ['files', 'quizzes'], onProgress: quiet });

  const c2 = r.courses.find((c) => c.course_id === 2);
  assert.equal(c2.resources.files.state, 'unreadable');
  assert.equal(c2.resources.files.http_status, 403);
  assert.match(c2.resources.files.reason, /locked/);

  const c3 = r.courses.find((c) => c.course_id === 3);
  assert.equal(c3.resources.quizzes.state, 'unreadable');
  assert.equal(c3.resources.quizzes.http_status, 404);

  assert.equal(r.summary.errors, 0, 'a resource we are not allowed to read is not a sync failure');
  assert.ok(r.summary.unreadable.some((u) => u.endsWith('/files')));
  await mock.close();
});

test('the last sync records per-course reachability, distinguishing locked from empty', async () => {
  const { mock, db } = await synced({
    lockedCourses: { 2: ['files'] },
    missingCourses: { 3: ['quizzes'] },
    quizzesByCourse: { 1: [], 2: [], 3: [], 4: [], 5: [] },   // genuinely empty, not blocked
  });

  const row = (cid, res) => db.prepare('SELECT * FROM resource_status WHERE course_id=? AND resource=?').get(cid, res);

  assert.equal(row(2, 'files').ok, 0, 'locked files recorded as not ok');
  assert.equal(row(2, 'files').http_status, 403);

  assert.equal(row(3, 'quizzes').ok, 0, 'disabled quizzes recorded as not ok');
  assert.equal(row(3, 'quizzes').http_status, 404);

  const empty = row(1, 'quizzes');
  assert.equal(empty.ok, 1, 'an empty-but-readable resource is ok...');
  assert.equal(empty.row_count, 0, '...with zero rows — the distinction the log used to lose');

  assert.equal(row(1, 'files').ok, 1);
  assert.ok(row(1, 'files').checked_at, 'timestamped');
  await mock.close();
});

test('an expired cookie fails the verification instead of reporting a false pass', async () => {
  const { mock, db } = await synced();
  const dead = await startMockCanvas({ expireAfter: 0 });
  process.env.CANVAS_HOST = dead.url;
  await assert.rejects(() => verifyLive(db, { onProgress: quiet }), CanvasSessionExpired);
  await dead.close();
  await mock.close();
});

test('verification only ever issues GETs against Canvas', async () => {
  const { mock, db } = await synced();
  mock.state.methods.clear();
  await verifyLive(db, { entities: ['assignments'], onProgress: quiet });
  assert.deepEqual([...mock.state.methods], ['GET'], 'verifying is strictly read-only');
  await mock.close();
});

test('a 429 is retried rather than silently dropping the collection', async () => {
  // Canvas throttles the first two attempts, then serves the data.
  const mock = await startMockCanvas({
    throttle: { path: 'courses/1/assignments', times: 2, retryAfter: 0 },
    assignmentsByCourse: { 1: [{ id: 1001, name: 'Survives throttling', due_at: '2026-10-01T03:59:00Z', points_possible: 100, published: true, submission_types: ['online_upload'] }] },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;

  const stats = await runSync(db, { log: quiet });

  assert.equal(mock.throttledCount(), 2, 'the mock really did throttle twice');
  assert.ok(stats.requests.retried >= 2, 'the client backed off and retried');
  assert.equal(stats.requests.throttled, 0, 'and never gave up on the collection');

  const row = db.prepare('SELECT name FROM assignments WHERE id = 1001').get();
  assert.equal(row?.name, 'Survives throttling', 'the throttled collection still landed in the database');

  const reach = db.prepare("SELECT * FROM resource_status WHERE course_id=1 AND resource='assignments'").get();
  assert.equal(reach.ok, 1, 'and is not recorded as unreadable');
  await mock.close();
});

test('a resource throttled past every retry is recorded, not counted as empty', async () => {
  const mock = await startMockCanvas({
    throttle: { path: 'courses/1/assignments', times: 99, retryAfter: 0 },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;

  const stats = await runSync(db, { log: quiet });
  assert.equal(stats.requests.throttled, 1, 'the give-up is counted, not swallowed');

  const reach = db.prepare("SELECT * FROM resource_status WHERE course_id=1 AND resource='assignments'").get();
  assert.equal(reach.ok, 0, 'marked unreadable...');
  assert.equal(reach.http_status, 429, '...with the throttle status, distinguishable from locked or empty');
  await mock.close();
});

test('a string id from Canvas matches the integer id in SQLite', async () => {
  // Canvas quotes quiz ids. Comparing '141097' to 141097 makes the same row
  // look both missing and stale at once, which is how this was found.
  const mock = await startMockCanvas({
    quizzesByCourse: { 1: [{ id: '9001', title: 'Stringy id quiz', description: '<p>q</p>', points_possible: 10 }], 2: [], 3: [], 4: [], 5: [] },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const r = await verifyLive(db, { entities: ['quizzes'], courseId: 1, onProgress: quiet });
  assert.equal(findingsOf(r, 'missing_from_db').length, 0, 'a quoted id is not a missing row');
  assert.equal(findingsOf(r, 'stale_in_db').length, 0, 'nor an orphaned one');
  assert.equal(r.summary.ok, true);
  assert.equal(r.courses[0].resources.quizzes.in_db, 1);
  await mock.close();
});

test('announcements and discussions are compared separately, not against one shared table', async () => {
  // Both kinds live in `discussions`. Scoping the comparison to the whole table
  // reported every announcement as a missing discussion and vice versa.
  const { mock, db } = await synced();

  const counts = db.prepare("SELECT kind, COUNT(*) n FROM discussions WHERE course_id=1 GROUP BY kind").all();
  assert.ok(counts.length === 2, 'the fixture really does store both kinds');

  const r = await verifyLive(db, { entities: ['announcements', 'discussions'], courseId: 1, onProgress: quiet });
  assert.equal(r.summary.errors, 0, 'no cross-kind false positives');
  assert.equal(findingsOf(r, 'stale_in_db').length, 0);

  const res = r.courses[0].resources;
  assert.equal(res.announcements.in_db, 1, 'announcement side counts only announcements');
  assert.equal(res.discussions.in_db, 1, 'discussion side counts only discussions');
  await mock.close();
});

// ---- recovery of content behind a blocked index --------------------------

test('files behind a 403 index are recovered through module items', async () => {
  const mock = await startMockCanvas({
    lockedCourses: { 1: ['files'] },
    moduleItems: { 1: [
      { title: 'Slides.pdf', type: 'File', content_id: 555 },
      { title: 'Notes.pdf', type: 'File', content_id: 556 },
      { title: 'dup', type: 'File', content_id: 556 },   // same file twice in the course
    ] },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const files = db.prepare('SELECT * FROM files WHERE course_id=1 ORDER BY id').all();
  assert.equal(files.length, 2, 'both distinct files recovered, the duplicate fetched once');
  assert.deepEqual(files.map((f) => f.id), [555, 556]);

  const reach = db.prepare("SELECT * FROM resource_status WHERE course_id=1 AND resource='files'").get();
  assert.equal(reach.http_status, 403, 'the index really was blocked');
  assert.equal(reach.recovered, 2, 'and the recovery is recorded, not hidden');
  await mock.close();
});

test('pages behind a 404 index are recovered through module items', async () => {
  const mock = await startMockCanvas({
    missingCourses: { 1: ['pages'] },
    moduleItems: { 1: [{ title: 'Welcome', type: 'Page', page_url: 'welcome-page' }] },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const pages = db.prepare('SELECT * FROM pages WHERE course_id=1').all();
  assert.ok(pages.some((p) => p.url === 'welcome-page'), 'the page came back despite the 404 index');
  assert.ok(pages.find((p) => p.url === 'welcome-page').body_text, 'with its body, not just a stub');
  await mock.close();
});

test('a blocked index with nothing to recover is still reported unreadable', async () => {
  const mock = await startMockCanvas({ lockedCourses: { 1: ['files'] }, moduleItems: { 1: [] } });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const reach = db.prepare("SELECT * FROM resource_status WHERE course_id=1 AND resource='files'").get();
  assert.equal(reach.ok, 0);
  assert.equal(reach.recovered, 0, 'no false claim of recovery');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM files WHERE course_id=1').get().n, 0);
  await mock.close();
});

// ---- discussion replies ---------------------------------------------------

const THREAD = [
  { id: 900, user_name: 'Ada', message: '<p>My draft is attached</p>', created_at: '2026-09-01T10:00:00Z', replies: [
    { id: 901, user_name: 'Grace', message: '<p>Nice work, tighten section 2</p>', created_at: '2026-09-01T11:00:00Z', replies: [
      { id: 902, user_name: 'Ada', message: '<p>Fixed, thanks</p>', created_at: '2026-09-01T12:00:00Z' },
    ] },
  ] },
  { id: 903, user_name: 'Alan', message: '<p>Where is the rubric?</p>', created_at: '2026-09-02T09:00:00Z' },
];

test('every reply in a thread is stored, nested replies included', async () => {
  const mock = await startMockCanvas({
    subentryCounts: { 12: 4 },                 // course 1's discussion topic
    threadsByTopic: { 12: THREAD },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  const stats = await runSync(db, { log: quiet });

  assert.equal(stats.replies, 4, 'all four messages counted, not just the top level');
  const rows = db.prepare('SELECT * FROM discussion_entries WHERE topic_id=12 ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.id), [900, 901, 902, 903]);

  const nested = rows.find((r) => r.id === 902);
  assert.equal(nested.parent_id, 901, 'reply-to-a-reply keeps its parent');
  assert.equal(nested.depth, 2, 'and its depth');
  assert.equal(nested.author, 'Ada');
  assert.match(nested.message_text, /Fixed, thanks/, 'html reduced to searchable text');
  await mock.close();
});

test('replies are full-text searchable', async () => {
  const mock = await startMockCanvas({ subentryCounts: { 12: 4 }, threadsByTopic: { 12: THREAD } });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const hits = db.prepare(
    `SELECT d.kind, d.title, d.body FROM docs_fts f JOIN docs d ON d.id = f.rowid
      WHERE docs_fts MATCH ? AND d.kind = 'reply'`,
  ).all('rubric');
  assert.equal(hits.length, 1, 'a question asked only in a reply is findable');
  assert.match(hits[0].title, /Alan/);
  await mock.close();
});

test('threads without replies are never fetched', async () => {
  const mock = await startMockCanvas();   // all subentry counts default to 0
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  assert.equal(mock.state.paths.filter((p) => p.endsWith('/view')).length, 0, 'no wasted round trips');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM discussion_entries').get().n, 0);
  await mock.close();
});

test('the verifier catches a reply that Canvas has and the database does not', async () => {
  const thread = [{ id: 900, user_name: 'Ada', message: '<p>first</p>', created_at: '2026-09-01T10:00:00Z' }];
  const mock = await startMockCanvas({ subentryCounts: { 12: 1 }, threadsByTopic: { 12: thread } });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  assert.equal((await verifyLive(db, { entities: ['replies'], courseId: 1, onProgress: quiet })).summary.ok, true);

  thread.push({ id: 999, user_name: 'Alan', message: '<p>added later</p>', created_at: '2026-09-03T10:00:00Z' });

  const r = await verifyLive(db, { entities: ['replies'], courseId: 1, onProgress: quiet });
  assert.equal(r.summary.ok, false, 'a new reply upstream is a real gap');
  assert.equal(findingsOf(r, 'missing_from_db').length, 1);
  assert.match(findingsOf(r, 'missing_from_db')[0].detail, /999/);

  await runSync(db, { log: quiet });
  assert.equal((await verifyLive(db, { entities: ['replies'], courseId: 1, onProgress: quiet })).summary.ok, true, 'and a sync closes it');
  await mock.close();
});

test('reply authors are resolved from the participants list, not left unknown', async () => {
  // Canvas entries carry only user_id; names arrive in a sibling array. Getting
  // this wrong attributes every reply in every thread to nobody.
  const thread = [
    { id: 800, user_id: 11, message: '<p>opening</p>', created_at: '2026-09-01T10:00:00Z', replies: [
      { id: 801, user_id: 22, message: '<p>a reply</p>', created_at: '2026-09-01T11:00:00Z' },
    ] },
  ];
  const mock = await startMockCanvas({
    subentryCounts: { 12: 2 },
    threadsByTopic: { 12: thread },
    participantsByTopic: { 12: [{ id: 11, display_name: 'Ada Lovelace' }, { id: 22, display_name: 'Alan Turing' }] },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const rows = db.prepare('SELECT * FROM discussion_entries WHERE topic_id=12 ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.author), ['Ada Lovelace', 'Alan Turing'], 'both named');
  assert.deepEqual(rows.map((r) => r.author_id), [11, 22], 'and the id kept for disambiguation');
  assert.ok(rows.every((r) => r.author !== null), 'no reply is attributed to nobody');
  await mock.close();
});

test('an unknown participant leaves the author null rather than inventing one', async () => {
  const mock = await startMockCanvas({
    subentryCounts: { 12: 1 },
    threadsByTopic: { 12: [{ id: 810, user_id: 99, message: '<p>hi</p>', created_at: '2026-09-01T10:00:00Z' }] },
    participantsByTopic: { 12: [] },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const row = db.prepare('SELECT * FROM discussion_entries WHERE id=810').get();
  assert.equal(row.author, null);
  assert.equal(row.author_id, 99, 'the id is still recorded so it can be resolved later');
  await mock.close();
});
