/**
 * Walks every Canvas endpoint for every course and produces the same object
 * shape `canvas-dump.js` writes, then hands it to ingestDump() so the diff
 * engine sees each sync as a new snapshot to compare.
 *
 * Endpoint coverage is the list from the project brief, unchanged.
 */
import { CanvasClient, CanvasSessionExpired } from './canvas.js';
import { ingestDump } from './ingest.js';
import { getMeta, setMeta } from './db.js';
import { nowIso } from './util.js';

/** Read the active cookie: the settings page overrides the env var. */
export function getCookie(db) {
  return getMeta(db, 'canvas_cookie') || process.env.CANVAS_COOKIE || null;
}

export function setCookie(db, cookie) {
  setMeta(db, 'canvas_cookie', String(cookie).trim());
  setMeta(db, 'canvas_cookie_set_at', nowIso());
  setMeta(db, 'sync_state', 'idle');
  setMeta(db, 'sync_error', '');
}

export function syncStatus(db) {
  return {
    state: getMeta(db, 'sync_state') || 'never',
    last_sync_at: getMeta(db, 'last_sync_at'),
    last_attempt_at: getMeta(db, 'last_attempt_at'),
    last_error: getMeta(db, 'sync_error') || null,
    last_source: getMeta(db, 'last_sync_source'),
    cookie_configured: !!getCookie(db),
    cookie_set_at: getMeta(db, 'canvas_cookie_set_at'),
    stalled: getMeta(db, 'sync_state') === 'stalled',
  };
}

/** Pull one course's sub-resources. Every failure here is survivable. */
async function fetchCourse(client, course, log) {
  const id = course.id;
  const c = { ...course };
  const soft = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CanvasSessionExpired) throw err;
      log(`  course ${id}: ${label} failed (${err.message})`);
      return null;
    }
  };

  const [
    assignments, announcements, discussions, modules, quizzes, files, folders,
    pageList, frontPage, teachers, enrollments, groups, submissions, gradingPeriods,
  ] = await Promise.all([
    soft('assignments', () => client.getAll(`courses/${id}/assignments?include[]=submission&include[]=all_dates`)),
    soft('announcements', () => client.getAll(`courses/${id}/discussion_topics?only_announcements=true`)),
    soft('discussions', () => client.getAll(`courses/${id}/discussion_topics`)),
    soft('modules', () => client.getAll(`courses/${id}/modules?include[]=items`)),
    soft('quizzes', () => client.getAll(`courses/${id}/quizzes`)),
    soft('files', () => client.getAll(`courses/${id}/files`)),
    soft('folders', () => client.getAll(`courses/${id}/folders`)),
    soft('pages', () => client.getAll(`courses/${id}/pages`)),
    soft('front_page', () => client.get(`courses/${id}/front_page`)),
    soft('teachers', () => client.getAll(`courses/${id}/users?enrollment_type[]=teacher&enrollment_type[]=ta`)),
    soft('enrollments', () => client.getAll(`courses/${id}/enrollments?user_id=self`)),
    soft('assignment_groups', () => client.getAll(`courses/${id}/assignment_groups?include[]=assignments`)),
    soft('submissions', () => client.getAll(
      `courses/${id}/students/submissions?student_ids[]=self&include[]=assignment&include[]=submission_comments`,
    )),
    soft('grading_periods', () => client.get(`courses/${id}/grading_periods`)),
  ]);

  // ---- Recovery passes -------------------------------------------------
  // A course can lock its Files index (403) or switch Pages off (404) while
  // still exposing the very same objects as module items. The module item
  // carries the id, and the per-object endpoints answer 200, so anything
  // reachable that way is pulled back rather than silently dropped.
  const moduleItems = (modules || []).flatMap((m) => m.items || []);

  let recoveredFiles = [];
  if ((files == null || files.denied) && moduleItems.length) {
    const ids = [...new Set(moduleItems.filter((i) => i.type === 'File' && i.content_id).map((i) => i.content_id))];
    recoveredFiles = (await client.map(ids, (fid) => soft(`file ${fid}`, () => client.get(`files/${fid}`))))
      .filter(Boolean);
    if (recoveredFiles.length) log(`  course ${id}: recovered ${recoveredFiles.length} file(s) via modules`);
  }

  let recoveredPages = [];
  if ((pageList == null || pageList.denied) && moduleItems.length) {
    const urls = [...new Set(moduleItems.filter((i) => i.type === 'Page' && i.page_url).map((i) => i.page_url))];
    recoveredPages = (await client.map(urls, (u) => soft(`page ${u}`, () => client.get(`courses/${id}/pages/${encodeURIComponent(u)}`))))
      .filter(Boolean);
    if (recoveredPages.length) log(`  course ${id}: recovered ${recoveredPages.length} page(s) via modules`);
  }

  // Page bodies need a second GET each; that content is the point of the sync.
  const pages = await client.map(pageList || [], async (p) => {
    if (!p?.url) return p;
    const full = await (async () => {
      try {
        return await client.get(`courses/${id}/pages/${encodeURIComponent(p.url)}`);
      } catch (err) {
        if (err instanceof CanvasSessionExpired) throw err;
        return null;
      }
    })();
    return full ? { ...p, ...full } : p;
  });

  // Thread bodies. The topic list returns only the opening post, so every
  // reply needs a per-topic fetch. `discussion_subentry_count` tells us which
  // topics actually have replies, keeping this to the threads that need it.
  const topics = [...(announcements || []), ...(discussions || [])];
  const threaded = topics.filter((t) => (t.discussion_subentry_count || 0) > 0);
  const entries = (await client.map(threaded, async (t) => {
    const view = await soft(`thread ${t.id}`, () => client.get(`courses/${id}/discussion_topics/${t.id}/view`));
    // Entries carry only user_id; the display names live in a sibling
    // `participants` array, so the two have to be joined here or every reply
    // ends up attributed to nobody.
    const names = new Map((view?.participants || []).map((u) => [u.id, u.display_name || u.short_name]));
    return flattenEntries(view?.view || [], t.id, id, null, 0, [], names);
  })).flat();
  if (entries.length) log(`  course ${id}: ${entries.length} discussion repl${entries.length === 1 ? 'y' : 'ies'}`);

  // Resources we could not read this run. Passed through so the diff engine
  // does not mistake a locked or failed fetch for a deletion.
  const unavailable = [];
  const reachability = [];
  const recovered = { files: recoveredFiles.length, pages: recoveredPages.length };
  for (const [key, val] of [
    ['assignments', assignments], ['announcements', announcements], ['discussions', discussions],
    ['pages', pageList], ['quizzes', quizzes], ['files', files], ['modules', modules],
  ]) {
    const bad = val == null || val.denied;
    // A blocked index that we recovered through modules is no longer a hole in
    // the data, but it is not a clean read either — record both facts.
    const salvaged = bad ? (recovered[key] || 0) : 0;
    if (bad && !salvaged) unavailable.push(key);
    reachability.push({
      resource: key,
      ok: !bad,
      http_status: val?.deniedStatus || (val == null ? 0 : 200),
      row_count: bad ? salvaged : val.length,
      recovered: salvaged,
    });
  }
  reachability.push({
    resource: 'discussion_entries',
    ok: true,
    http_status: 200,
    row_count: entries.length,
    recovered: 0,
  });

  Object.assign(c, {
    __unavailable: unavailable,
    __reachability: reachability,
    assignments: assignments || [],
    announcements: announcements || [],
    discussions: discussions || [],
    modules: modules || [],
    quizzes: quizzes || [],
    files: [...(files || []), ...recoveredFiles],
    folders: folders || [],
    pages: [...pages, ...recoveredPages],
    discussion_entries: entries,
    front_page: frontPage || null,
    teachers: teachers?.length ? teachers : course.teachers || [],
    my_enrollment: enrollments || [],
    assignment_groups: groups || [],
    submissions: submissions || [],
    grading_periods: gradingPeriods?.grading_periods || gradingPeriods || [],
  });
  return c;
}

/**
 * Full sync: fetch everything, then diff it into SQLite.
 * @returns {Promise<object>} ingest stats plus request counters
 */
export async function runSync(db, { log = console.log } = {}) {
  const cookie = getCookie(db);
  if (!cookie) {
    setMeta(db, 'sync_state', 'no_cookie');
    setMeta(db, 'sync_error', 'No Canvas cookie configured.');
    throw new Error('No Canvas cookie configured. Paste one on the settings page.');
  }

  setMeta(db, 'last_attempt_at', nowIso());
  setMeta(db, 'sync_state', 'running');
  const host = process.env.CANVAS_HOST || getMeta(db, 'canvas_host') || 'https://gatech.instructure.com';
  const client = new CanvasClient({ host, cookie, log });

  try {
    const profile = await client.whoami();
    if (!profile?.id) throw new CanvasSessionExpired();
    log(`sync: authenticated as ${profile.name}`);

    const courses = await client.getAll(
      'courses?enrollment_state=active&include[]=term&include[]=teachers&include[]=syllabus_body&include[]=total_scores',
    );
    log(`sync: ${courses.length} active courses`);

    const start = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const [todo, upcoming, planner] = await Promise.all([
      client.getAll('users/self/todo').catch(() => []),
      client.getAll('users/self/upcoming_events').catch(() => []),
      client.getAll(`planner/items?start_date=${start}`).catch(() => []),
    ]);

    const full = [];
    let done = 0;
    await client.map(courses, async (course) => {
      const c = await fetchCourse(client, course, log);
      full.push(c);
      if (++done % 10 === 0) log(`sync: ${done}/${courses.length} courses`);
    });
    full.sort((a, b) => courses.findIndex((c) => c.id === a.id) - courses.findIndex((c) => c.id === b.id));

    const dump = {
      fetched_at: nowIso(),
      host,
      profile,
      todo,
      upcoming_events: upcoming,
      planner_items: planner,
      courses: full,
      __source: 'live',
    };

    const stats = ingestDump(db, dump);
    setMeta(db, 'sync_state', 'ok');
    setMeta(db, 'sync_error', '');
    log(`sync: done — ${stats.changes} changes, ${client.stats.requests} requests ` +
        `(${client.stats.denied} denied, ${client.stats.missing} missing, ` +
        `${client.stats.retried} retried, ${client.stats.throttled} throttled)`);
    return { ...stats, requests: client.stats };
  } catch (err) {
    if (err instanceof CanvasSessionExpired) {
      setMeta(db, 'sync_state', 'stalled');
      setMeta(db, 'sync_error', 'Canvas session expired. Paste a fresh cookie on the settings page.');
      log('sync: STALLED — Canvas session expired. Serving last-synced data.');
    } else {
      setMeta(db, 'sync_state', 'error');
      setMeta(db, 'sync_error', err.message);
      log(`sync: failed — ${err.message}`);
    }
    throw err;
  }
}

/** Sync on boot, then every `hours`. Failures never kill the process. */
export function startScheduler(db, { hours = 12, log = console.log } = {}) {
  let running = false;
  const tick = async (reason) => {
    if (running) return;
    running = true;
    try {
      log(`sync: starting (${reason})`);
      await runSync(db, { log });
    } catch (err) {
      // State is already recorded on the db and we keep serving what we have,
      // but say why out loud so a quiet log is not mistaken for a healthy one.
      log(`sync: skipped — ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => tick('scheduled'), hours * 3600 * 1000);
  timer.unref?.();
  setTimeout(() => tick('boot'), 1500).unref?.();
  return { tick, stop: () => clearInterval(timer), isRunning: () => running };
}


/**
 * Canvas returns a discussion thread as a nested tree. Flatten it so replies
 * are addressable rows, keeping parent_id and depth so the shape survives.
 */
function flattenEntries(nodes, topicId, courseId, parentId = null, depth = 0, out = [], names = new Map()) {
  for (const n of nodes) {
    if (n?.id == null) continue;
    out.push({
      id: n.id,
      topic_id: topicId,
      course_id: courseId,
      parent_id: n.parent_id ?? parentId,
      depth,
      author: n.user_name ?? n.user?.display_name ?? names.get(n.user_id) ?? null,
      author_id: n.user_id ?? null,
      message_html: n.message ?? null,
      created_at: n.created_at ?? null,
      updated_at: n.updated_at ?? null,
      deleted: n.deleted ? 1 : 0,
    });
    if (n.replies?.length) flattenEntries(n.replies, topicId, courseId, n.id, depth + 1, out, names);
  }
  return out;
}
