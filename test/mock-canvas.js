/**
 * A mock Canvas API. Reproduces the three behaviours that bite cookie-auth
 * clients: the while(1); prefix, Link-header pagination, and routine 403/404s
 * on locked resources.
 */
import http from 'node:http';

export const COOKIE = 'canvas_session=abc123; _normandy_session=xyz';

/** @param {object} opts */
export function startMockCanvas(opts = {}) {
  const {
    pageSize = 2,
    expireAfter = Infinity,   // requests before the session starts 401ing
    lockedCourses = { 2: ['pages', 'files'] },  // course id -> resources that 403
    missingCourses = { 3: ['front_page', 'quizzes'] }, // -> 404
    courses = defaultCourses(),
    assignmentsByCourse = defaultAssignments(),
    quizzesByCourse = null,   // null = default one quiz per course; {} = none
  } = opts;

  const state = { requests: 0, paths: [], methods: new Set(), cookiesSeen: new Set() };

  const server = http.createServer((req, res) => {
    state.requests++;
    state.methods.add(req.method);
    if (req.headers.cookie) state.cookiesSeen.add(req.headers.cookie);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname.replace(/^\/api\/v1\//, '');
    state.paths.push(p);

    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (!req.headers.cookie) return send(res, 401, { status: 'unauthenticated' });
    if (state.requests > expireAfter) return send(res, 401, { status: 'unauthenticated' });

    const courseMatch = p.match(/^courses\/(\d+)\/(.+)$/);
    if (courseMatch) {
      const [, cid, resource] = courseMatch;
      const head = resource.split('/')[0];
      if ((lockedCourses[cid] || []).includes(head)) {
        return send(res, 403, { status: 'unauthorized', errors: [{ message: 'user not authorized' }] });
      }
      if ((missingCourses[cid] || []).includes(head)) {
        return send(res, 404, { errors: [{ message: 'The specified resource does not exist.' }] });
      }
    }

    if (p === 'users/self/profile') return send(res, 200, { id: 7, name: 'Test Student', time_zone: 'America/New_York' });
    if (p === 'users/self/todo' || p === 'users/self/upcoming_events' || p === 'planner/items') return page(res, url, [], pageSize);
    if (p === 'courses') return page(res, url, courses, pageSize);

    if (courseMatch) {
      const [, cid, resource] = courseMatch;
      const head = resource.split('/')[0];
      const pageName = resource.match(/^pages\/(.+)$/)?.[1];
      if (pageName) {
        return send(res, 200, {
          page_id: Number(cid) * 100 + 1, url: pageName, title: `Page ${pageName}`,
          body: `<p>Body of ${pageName} in course ${cid}</p>`, updated_at: '2026-01-01T00:00:00Z',
        });
      }
      switch (head) {
        case 'assignments': return page(res, url, assignmentsByCourse[cid] || [], pageSize);
        case 'discussion_topics': {
          const only = url.searchParams.get('only_announcements') === 'true';
          return page(res, url, only
            ? [{ id: Number(cid) * 10 + 1, title: `Announcement in ${cid}`, message: '<p>Hello class</p>', posted_at: '2026-02-01T00:00:00Z', html_url: `http://x/courses/${cid}/discussion_topics/1` }]
            : [{ id: Number(cid) * 10 + 2, title: `Discussion in ${cid}`, message: '<p>Talk</p>', posted_at: '2026-02-02T00:00:00Z', html_url: `http://x/courses/${cid}/discussion_topics/2` }],
            pageSize);
        }
        case 'modules': return page(res, url, [{ id: Number(cid) * 10, name: `Module ${cid}`, position: 1, items: [{ title: 'Item A', type: 'Page' }] }], pageSize);
        case 'quizzes': return page(res, url, quizzesByCourse
          ? (quizzesByCourse[cid] || [])
          : [{ id: Number(cid) * 10, title: `Quiz ${cid}`, description: '<p>quiz</p>', points_possible: 10 }], pageSize);
        case 'files': return page(res, url, [{ id: Number(cid) * 10, display_name: `file${cid}.pdf`, filename: `file${cid}.pdf`, 'content-type': 'application/pdf', size: 100 }], pageSize);
        case 'folders': return page(res, url, [{ id: 1, full_name: 'course files' }], pageSize);
        case 'pages': return page(res, url, [{ page_id: Number(cid) * 100 + 1, url: 'syllabus-page', title: 'Syllabus Page' }], pageSize);
        case 'front_page': return send(res, 200, { page_id: Number(cid) * 100 + 9, url: 'front', title: 'Front', body: '<p>Front page</p>', front_page: true });
        case 'users': return page(res, url, [{ id: 1, name: 'Prof X' }], pageSize);
        case 'enrollments': return page(res, url, [{ type: 'StudentEnrollment', computed_current_score: 91 }], pageSize);
        case 'assignment_groups': return page(res, url, [{ id: 1, name: 'Homework' }], pageSize);
        case 'students': return page(res, url, [], pageSize);
        case 'grading_periods': return send(res, 200, { grading_periods: [] });
        default: return send(res, 404, { errors: [{ message: 'not found' }] });
      }
    }
    return send(res, 404, { errors: [{ message: 'not found' }] });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Every response carries the while(1); prefix, exactly as Canvas does. */
function send(res, status, body) {
  const text = 'while(1);' + JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** Paginate with a Link header, the only cursor Canvas gives us. */
function page(res, url, items, pageSize) {
  const p = Number(url.searchParams.get('page') || 1);
  const per = Number(url.searchParams.get('per_page') || pageSize);
  const size = Math.min(per, pageSize);
  const slice = items.slice((p - 1) * size, p * size);
  const links = [];
  if (p * size < items.length) {
    const next = new URL(url);
    next.searchParams.set('page', String(p + 1));
    links.push(`<${next.href}>; rel="next"`);
  }
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (links.length) headers.Link = links.join(', ');
  res.writeHead(200, headers);
  res.end('while(1);' + JSON.stringify(slice));
}

function defaultCourses() {
  return [1, 2, 3, 4, 5].map((id) => ({
    id, name: `Course ${id}`, course_code: `C-${id}`, workflow_state: 'available',
    term: { name: 'Fall 2026' }, teachers: [{ name: 'Prof X' }],
    syllabus_body: `<p>Syllabus for course ${id}</p>`,
    enrollments: [{ type: 'student', computed_current_score: 80 + id }],
  }));
}

function defaultAssignments() {
  const mk = (cid, n) => ({
    id: cid * 1000 + n,
    name: `Assignment ${n} (course ${cid})`,
    description: `<p>Do the thing ${n}</p>`,
    due_at: '2026-10-0' + ((n % 8) + 1) + 'T03:59:00Z',
    points_possible: 100,
    published: true,
    html_url: `http://x/courses/${cid}/assignments/${cid * 1000 + n}`,
    submission_types: ['online_upload'],
    submission: { assignment_id: cid * 1000 + n, workflow_state: 'unsubmitted', score: null },
  });
  return {
    1: [mk(1, 1), mk(1, 2), mk(1, 3), mk(1, 4), mk(1, 5)], // 5 items, pageSize 2 -> 3 pages
    2: [mk(2, 1)],
    3: [mk(3, 1), mk(3, 2)],
    4: [mk(4, 1)],
    5: [mk(5, 1)],
  };
}
