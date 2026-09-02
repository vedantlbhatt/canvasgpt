/**
 * Live verification: does what is in Canvas right now actually match what is
 * in SQLite?
 *
 * The sync's own counters cannot answer that — they report what the sync
 * believed it did. This module re-fetches from Canvas independently and diffs
 * the result against the stored rows, so a silently dropped write, a stalled
 * cookie, or a resource that quietly stopped being readable all show up as a
 * concrete row rather than as a number that looks fine.
 */
import { CanvasClient, CanvasSessionExpired } from './canvas.js';
import { getMeta } from './db.js';
import { getCookie } from './sync.js';
import { nowIso } from './util.js';

const HOST = () => process.env.CANVAS_HOST || 'https://gatech.instructure.com';

/** Entities cheap enough to re-fetch on demand, with how to read each one. */
const PROBES = {
  assignments: {
    path: (id) => `courses/${id}/assignments?include[]=submission`,
    table: 'assignments',
    pk: 'id',
    // Fields we claim to keep in sync. Compared verbatim against Canvas.
    compare: (a) => ({ name: a.name ?? null, due_at: a.due_at ?? null, points: a.points_possible ?? null }),
    row: (r) => ({ name: r.name ?? null, due_at: r.due_at ?? null, points: r.points_possible ?? null }),
  },
  quizzes: {
    path: (id) => `courses/${id}/quizzes`,
    table: 'quizzes',
    pk: 'id',
    compare: (q) => ({ title: q.title ?? null, due_at: q.due_at ?? null }),
    row: (r) => ({ title: r.title ?? null, due_at: r.due_at ?? null }),
  },
  files: {
    path: (id) => `courses/${id}/files`,
    table: 'files',
    pk: 'id',
    compare: (f) => ({ name: f.display_name ?? null }),
    row: (r) => ({ name: r.display_name ?? null }),
  },
  // Announcements and discussions share one table, split by `kind`, and Canvas
  // serves them from the same endpoint under different flags. Comparing either
  // one against the whole table reports every row of the other kind as both
  // missing and stale, so each probe scopes itself to its own kind.
  announcements: {
    path: (id) => `courses/${id}/discussion_topics?only_announcements=true`,
    table: 'discussions',
    pk: 'id',
    where: { kind: 'announcement' },
    compare: (d) => ({ title: d.title ?? null }),
    row: (r) => ({ title: r.title ?? null }),
  },
  discussions: {
    path: (id) => `courses/${id}/discussion_topics`,
    table: 'discussions',
    pk: 'id',
    where: { kind: 'discussion' },
    compare: (d) => ({ title: d.title ?? null }),
    row: (r) => ({ title: r.title ?? null }),
  },
};

/**
 * Replies do not hang off a course-level collection, so they are verified by
 * walking each topic's thread and comparing the flattened result. Kept apart
 * from PROBES because it needs two levels of fetch.
 */
async function verifyReplies(client, db, course) {
  const topics = [
    ...await client.getAll(`courses/${course.id}/discussion_topics?only_announcements=true`),
    ...await client.getAll(`courses/${course.id}/discussion_topics`),
  ].filter((t) => (t.discussion_subentry_count || 0) > 0);

  const liveIds = new Set();
  for (const t of topics) {
    const view = await client.get(`courses/${course.id}/discussion_topics/${t.id}/view`);
    collectIds(view?.view || [], liveIds);
  }

  const rows = db.prepare('SELECT id FROM discussion_entries WHERE course_id = ?').all(course.id);
  const storedIds = new Set(rows.map((r) => idOf(r.id)));
  const missing = [...liveIds].filter((id) => !storedIds.has(id));

  return {
    state: missing.length ? 'out_of_date' : 'match',
    in_canvas: liveIds.size,
    in_db: storedIds.size,
    threads: topics.length,
    missing_from_db: missing.map((id) => ({ id, label: `reply ${id}` })),
    drifted: [],
    stale_in_db: [...storedIds].filter((id) => !liveIds.has(id)).map((id) => ({ id, label: `reply ${id}` })),
  };
}

function collectIds(nodes, into) {
  for (const n of nodes) {
    if (n?.id != null) into.add(idOf(n.id));
    if (n?.replies?.length) collectIds(n.replies, into);
  }
  return into;
}

// Canvas is inconsistent about whether an id is a JSON number or a string
// (quiz ids come back quoted); SQLite always gives us an integer. Comparing the
// two directly makes every row look simultaneously missing and stale.
const idOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Re-fetch `entities` for every active course and diff against SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string[]} opts.entities  keys of PROBES; defaults to all
 * @param {number}  opts.courseId   restrict to one course
 * @param {(s:string)=>void} opts.onProgress
 * @returns {Promise<object>} report — see `summary` for the pass/fail verdict
 */
export async function verifyLive(db, { entities = [...Object.keys(PROBES), 'replies'], courseId = null, onProgress = () => {} } = {}) {
  const cookie = getCookie(db);
  if (!cookie) throw new Error('No Canvas cookie configured. Paste one on the settings page.');

  const client = new CanvasClient({ host: HOST(), cookie, log: () => {} });
  const startedAt = nowIso();

  const profile = await client.whoami(); // throws CanvasSessionExpired if dead
  onProgress(`authenticated as ${profile?.name ?? 'unknown'}`);

  const courses = (await client.getAll('courses?enrollment_state=active'))
    .filter((c) => !courseId || c.id === courseId);
  onProgress(`${courses.length} active course${courses.length === 1 ? '' : 's'}`);

  const findings = [];
  const perCourse = [];

  await client.map(courses, async (course) => {
    const entry = { course_id: course.id, name: course.name, code: course.course_code, resources: {} };

    for (const key of entities) {
      if (key === 'replies') {
        const r = await verifyReplies(client, db, course);
        entry.resources.replies = r;
        for (const m of r.missing_from_db) {
          findings.push({ severity: 'error', course: course.name, entity: 'replies', kind: 'missing_from_db',
            detail: `${m.label} is in a Canvas thread but was never stored` });
        }
        for (const st of r.stale_in_db) {
          findings.push({ severity: 'warn', course: course.name, entity: 'replies', kind: 'stale_in_db',
            detail: `${st.label} is stored but no longer in Canvas` });
        }
        continue;
      }
      const probe = PROBES[key];
      const live = await client.getAll(probe.path(course.id));

      if (live.denied) {
        entry.resources[key] = {
          state: 'unreadable',
          http_status: live.deniedStatus,
          reason: live.deniedStatus === 403 ? 'locked to students' : 'feature disabled for this course',
          in_canvas: null,
          in_db: countRows(db, probe.table, course.id, probe.where?.kind),
        };
        continue;
      }

      const rows = probe.where?.kind
        ? db.prepare(`SELECT * FROM ${probe.table} WHERE course_id = ? AND kind = ?`).all(course.id, probe.where.kind)
        : db.prepare(`SELECT * FROM ${probe.table} WHERE course_id = ?`).all(course.id);
      const byId = new Map(rows.map((r) => [idOf(r[probe.pk]), r]));
      const liveIds = new Set();

      const missing = [];   // Canvas has it, we do not — the sync dropped it
      const drifted = [];   // both have it, stored copy is out of date

      for (const item of live) {
        const id = idOf(item.id ?? item.page_id);
        liveIds.add(id);
        const row = byId.get(id);
        if (!row) {
          missing.push({ id, label: item.name || item.title || item.display_name || String(id) });
          continue;
        }
        const want = probe.compare(item);
        const got = probe.row(row);
        if (!same(want, got)) drifted.push({ id, label: item.name || item.title || item.display_name || String(id), canvas: want, stored: got });
      }

      // Stored but no longer upstream. Expected right after an upstream delete
      // and before the next sync; suspicious only if it persists.
      const stale = rows.filter((r) => !liveIds.has(idOf(r[probe.pk])))
        .map((r) => ({ id: r[probe.pk], label: r.name || r.title || r.display_name || String(r[probe.pk]) }));

      entry.resources[key] = {
        state: missing.length || drifted.length ? 'out_of_date' : 'match',
        in_canvas: live.length,
        in_db: rows.length,
        missing_from_db: missing,
        drifted,
        stale_in_db: stale,
      };

      for (const m of missing) {
        findings.push({ severity: 'error', course: course.name, entity: key, kind: 'missing_from_db',
          detail: `"${m.label}" is in Canvas but was never stored` });
      }
      for (const d of drifted) {
        findings.push({ severity: 'error', course: course.name, entity: key, kind: 'drifted',
          detail: `"${d.label}" differs: Canvas ${JSON.stringify(d.canvas)} vs stored ${JSON.stringify(d.stored)}` });
      }
      for (const s of stale) {
        findings.push({ severity: 'warn', course: course.name, entity: key, kind: 'stale_in_db',
          detail: `"${s.label}" is stored but no longer in Canvas` });
      }
    }
    perCourse.push(entry);
    onProgress(`checked ${course.course_code || course.name}`);
  });

  perCourse.sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name)));

  const errors = findings.filter((f) => f.severity === 'error').length;
  return {
    started_at: startedAt,
    finished_at: nowIso(),
    user: profile?.name ?? null,
    last_sync_at: getMeta(db, 'last_sync_at'),
    sync_age_hours: ageHours(getMeta(db, 'last_sync_at')),
    requests: client.stats,
    courses: perCourse,
    findings,
    summary: {
      ok: errors === 0,
      courses_checked: perCourse.length,
      errors,
      warnings: findings.length - errors,
      unreadable: perCourse.flatMap((c) => Object.entries(c.resources)
        .filter(([, v]) => v.state === 'unreadable')
        .map(([k]) => `${c.code || c.name}/${k}`)),
    },
  };
}

function countRows(db, table, courseId, kind) {
  return kind
    ? db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE course_id = ? AND kind = ?`).get(courseId, kind).n
    : db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE course_id = ?`).get(courseId).n;
}

function ageHours(iso) {
  if (!iso) return null;
  return Math.round(((Date.now() - Date.parse(iso)) / 36e5) * 10) / 10;
}

/** Reachability recorded by the last live sync, for the dashboard. */
export function storedReachability(db) {
  return db.prepare(
    `SELECT rs.course_id, c.name, c.course_code, rs.resource, rs.ok, rs.http_status, rs.row_count, rs.recovered, rs.checked_at
       FROM resource_status rs LEFT JOIN courses c ON c.id = rs.course_id
      ORDER BY rs.ok ASC, c.course_code`,
  ).all();
}

export { PROBES, CanvasSessionExpired };
