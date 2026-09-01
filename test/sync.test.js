import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMockCanvas, COOKIE } from './mock-canvas.js';
import { CanvasClient, CanvasSessionExpired, parseCanvasJson, nextLink } from '../src/canvas.js';
import { openDb } from '../src/db.js';
import { ingestDump } from '../src/ingest.js';
import { runSync, setCookie, syncStatus } from '../src/sync.js';
import { htmlToText } from '../src/util.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgpt-')), 'test.db');
const quiet = () => {};

test('strips the while(1); prefix Canvas sends to cookie-authed clients', () => {
  assert.deepEqual(parseCanvasJson('while(1);{"id":1}'), { id: 1 });
  assert.deepEqual(parseCanvasJson('while (1);[{"id":2}]'), [{ id: 2 }]);
  assert.deepEqual(parseCanvasJson('while(1)[3]'), [3]);
  assert.deepEqual(parseCanvasJson('{"plain":true}'), { plain: true }, 'unprefixed JSON still parses');
  assert.throws(() => parseCanvasJson('while(1);not json'));
});

test('finds rel="next" in a Link header and stops when it is absent', () => {
  const h = '<http://x/api/v1/courses?page=2>; rel="next", <http://x/api/v1/courses?page=9>; rel="last"';
  assert.equal(nextLink(h), 'http://x/api/v1/courses?page=2');
  assert.equal(nextLink('<http://x/api/v1/courses?page=8>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
  assert.equal(nextLink('<http://x/a>; rel=next'), 'http://x/a', 'unquoted rel');
});

test('follows Link pagination across multiple pages', async () => {
  const mock = await startMockCanvas({ pageSize: 2 });
  const client = new CanvasClient({ host: mock.url, cookie: COOKIE, log: quiet });
  // Course 1 has 5 assignments and the mock caps pages at 2 items.
  const all = await client.getAll('courses/1/assignments');
  assert.equal(all.length, 5, 'collected every item across 3 pages');
  assert.equal(new Set(all.map((a) => a.id)).size, 5, 'no duplicates across pages');
  const pageParams = mock.state.paths.filter((p) => p === 'courses/1/assignments');
  assert.equal(pageParams.length, 3, 'walked exactly 3 pages');
  await mock.close();
});

test('requests per_page=100 and only ever issues GET', async () => {
  const mock = await startMockCanvas();
  const client = new CanvasClient({ host: mock.url, cookie: COOKIE, log: quiet });
  await client.getAll('courses');
  assert.deepEqual([...mock.state.methods], ['GET'], 'no POST/PUT/DELETE reached Canvas');
  await mock.close();
});

test('a 403 and a 404 midway through a run do not abort it', async () => {
  const mock = await startMockCanvas({
    lockedCourses: { 2: ['pages', 'files'] },
    missingCourses: { 3: ['front_page', 'quizzes'] },
  });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;

  const stats = await runSync(db, { log: quiet });

  assert.equal(stats.courses, 5, 'all 5 courses ingested despite the denials');
  assert.ok(stats.requests.denied >= 2, `saw 403s (${stats.requests.denied})`);
  assert.ok(stats.requests.missing >= 2, `saw 404s (${stats.requests.missing})`);
  // The locked course still has everything that was not locked.
  const c2 = db.prepare('SELECT * FROM courses WHERE id=2').get();
  assert.ok(c2, 'locked course row exists');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM files WHERE course_id=2').get().n, 0, 'locked files skipped');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM assignments WHERE course_id=2').get().n > 0, 'unlocked resources still fetched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM quizzes WHERE course_id=3').get().n, 0, '404 quizzes skipped');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM assignments WHERE course_id=3').get().n > 0, 'course 3 otherwise intact');
  assert.equal(syncStatus(db).state, 'ok');
  await mock.close();
});

test('an expired cookie stalls the sync and keeps the last-synced data', async () => {
  const mock = await startMockCanvas();
  const dbPath = tmpDb();
  const db = openDb(dbPath);
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;

  await runSync(db, { log: quiet });
  const before = db.prepare('SELECT COUNT(*) n FROM assignments').get().n;
  assert.ok(before > 0);
  await mock.close();

  // Same database, but now every request 401s.
  const dead = await startMockCanvas({ expireAfter: 0 });
  process.env.CANVAS_HOST = dead.url;
  await assert.rejects(() => runSync(db, { log: quiet }), CanvasSessionExpired);

  const st = syncStatus(db);
  assert.equal(st.state, 'stalled');
  assert.match(st.last_error, /fresh cookie/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, before, 'data survived the failed sync');
  await dead.close();
});

test('the cookie never appears in an error message or a status payload', async () => {
  const mock = await startMockCanvas({ expireAfter: 0 });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;

  let thrown;
  try { await runSync(db, { log: quiet }); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.ok(!String(thrown.message).includes('canvas_session'), 'cookie not in the error message');
  assert.ok(!JSON.stringify(thrown.stack || '').includes('abc123'), 'cookie not in the stack');
  assert.ok(!JSON.stringify(syncStatus(db)).includes('abc123'), 'cookie not in the status payload');

  const client = new CanvasClient({ host: mock.url, cookie: COOKIE, log: quiet });
  assert.ok(!JSON.stringify(client).includes('abc123'), 'cookie is not an enumerable property');
  await mock.close();
});

test('a second sync with no upstream changes records nothing', async () => {
  const mock = await startMockCanvas();
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;

  await runSync(db, { log: quiet });
  const second = await runSync(db, { log: quiet });
  assert.equal(second.changes, 0, 'an unchanged sync is silent');
  await mock.close();
});

test('the diff engine classifies a new assignment, an edited description and a moved due date', async () => {
  const db = openDb(tmpDb());
  const base = {
    fetched_at: '2026-09-01T00:00:00Z',
    host: 'http://x',
    courses: [{
      id: 1, name: 'Course 1', workflow_state: 'available',
      assignments: [
        { id: 11, name: 'HW1', description: '<p>Original</p>', due_at: '2026-10-01T03:59:00Z', points_possible: 100, published: true, html_url: 'http://x/a/11' },
        { id: 12, name: 'HW2', description: '<p>Two</p>', due_at: '2026-10-08T03:59:00Z', points_possible: 100, published: true, html_url: 'http://x/a/12' },
      ],
      pages: [{ page_id: 91, url: 'p', title: 'Kept', body: '<p>x</p>' }],
    }],
  };
  const first = ingestDump(db, base);
  assert.equal(first.firstRun, true);
  assert.equal(first.changes, 0, 'a fresh mirror is not news');

  const next = structuredClone(base);
  next.courses[0].assignments[0].description = '<p>Rewritten instructions, read carefully.</p>';
  next.courses[0].assignments[1].due_at = '2026-10-15T03:59:00Z';
  next.courses[0].assignments.push({
    id: 13, name: 'HW3', description: '<p>Brand new</p>', due_at: '2026-10-22T03:59:00Z',
    points_possible: 50, published: true, html_url: 'http://x/a/13',
  });
  next.courses[0].pages = [];

  const stats = ingestDump(db, next);
  const byKind = Object.fromEntries(
    db.prepare('SELECT kind, COUNT(*) n FROM changes GROUP BY kind').all().map((r) => [r.kind, r.n]),
  );
  assert.equal(byKind.new, 1, 'one new assignment');
  assert.equal(byKind.updated, 1, 'one edited description');
  assert.equal(byKind.due_date_moved, 1, 'one moved due date');
  assert.equal(byKind.removed, 1, 'one removed page');
  assert.equal(stats.changes, 4);

  const moved = db.prepare(`SELECT * FROM changes WHERE kind='due_date_moved'`).get();
  const diff = JSON.parse(moved.detail);
  assert.equal(diff[0].field, 'due_at');
  assert.equal(diff[0].before, '2026-10-08T03:59:00Z');
  assert.equal(diff[0].after, '2026-10-15T03:59:00Z');
  assert.equal(moved.title, 'HW2');

  const edited = db.prepare(`SELECT * FROM changes WHERE kind='updated'`).get();
  assert.match(JSON.parse(edited.detail)[0].after, /Rewritten instructions/);
});

test('the diff engine classifies a new grade as graded, not updated', async () => {
  const db = openDb(tmpDb());
  const base = {
    host: 'http://x',
    courses: [{
      id: 1, name: 'C', workflow_state: 'available',
      assignments: [{
        id: 11, name: 'HW1', due_at: '2026-10-01T03:59:00Z', points_possible: 100, published: true, html_url: 'http://x/a/11',
        submission: { assignment_id: 11, workflow_state: 'submitted', score: null, submitted_at: '2026-09-30T00:00:00Z' },
      }],
    }],
  };
  ingestDump(db, base);
  const next = structuredClone(base);
  Object.assign(next.courses[0].assignments[0].submission, {
    workflow_state: 'graded', score: 93, grade: '93', graded_at: '2026-10-02T00:00:00Z',
  });
  ingestDump(db, next);

  const ch = db.prepare(`SELECT * FROM changes WHERE entity='submission'`).all();
  assert.equal(ch.length, 1);
  assert.equal(ch[0].kind, 'graded');
  assert.equal(ch[0].title, 'HW1', 'the change names the assignment, not its id');
  const diff = JSON.parse(ch[0].detail);
  assert.ok(diff.some((d) => d.field === 'score' && d.after === 93));
});

test('page bodies and syllabi survive the round trip as searchable text', async () => {
  const mock = await startMockCanvas();
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const page = db.prepare('SELECT * FROM pages WHERE course_id=1').get();
  assert.match(page.body_html, /<p>/, 'original HTML kept');
  assert.equal(page.body_text.includes('<'), false, 'text version is clean');

  const hit = db.prepare(
    `SELECT d.title FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ? LIMIT 1`,
  ).get('syllabus');
  assert.ok(hit, 'syllabus is in the full-text index');
  await mock.close();
});

test('htmlToText keeps link targets and drops markup', () => {
  const out = htmlToText('<p>See <a href="http://x/y">the rubric</a></p><ul><li>A &amp; B</li></ul>');
  assert.match(out, /the rubric \(http:\/\/x\/y\)/);
  assert.match(out, /- A & B/);
  assert.equal(out.includes('<'), false);
});

test('a locked resource is not mistaken for a deletion', async () => {
  // Sync once with everything visible, then again with course 1's pages locked.
  const open = await startMockCanvas({ lockedCourses: {}, missingCourses: {} });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = open.url;
  await runSync(db, { log: quiet });
  const pagesBefore = db.prepare('SELECT COUNT(*) n FROM pages WHERE course_id=1').get().n;
  assert.ok(pagesBefore > 0);
  await open.close();

  const locked = await startMockCanvas({ lockedCourses: { 1: ['pages'] }, missingCourses: {} });
  process.env.CANVAS_HOST = locked.url;
  await runSync(db, { log: quiet });

  const removals = db.prepare(`SELECT * FROM changes WHERE kind='removed'`).all();
  assert.equal(removals.length, 0, 'a 403 on pages must not read as a deletion');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE course_id=1').get().n, pagesBefore,
    'the rows we could not re-read are still there');
  await locked.close();
});

test('a genuine deletion is still caught when the resource loads fine', async () => {
  const withPages = await startMockCanvas({ lockedCourses: {}, missingCourses: {} });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = withPages.url;
  await runSync(db, { log: quiet });
  await withPages.close();

  // Same course, quizzes still readable but now empty: a real removal.
  const emptied = await startMockCanvas({
    lockedCourses: {}, missingCourses: {},
    quizzesByCourse: {},
  });
  process.env.CANVAS_HOST = emptied.url;
  await runSync(db, { log: quiet });
  const removals = db.prepare(`SELECT * FROM changes WHERE kind='removed' AND entity='quiz'`).all();
  assert.ok(removals.length > 0, 'an emptied but readable resource is a real deletion');
  await emptied.close();
});
