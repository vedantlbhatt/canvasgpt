import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { localTime, truncate } from './util.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 1));

/** Resolve a course by id, code, or fuzzy name. */
function findCourses(db, needle) {
  if (!needle) return db.prepare(`SELECT * FROM courses WHERE workflow_state = 'available' ORDER BY name`).all();
  const n = String(needle).trim();
  if (/^\d+$/.test(n)) {
    const byId = db.prepare('SELECT * FROM courses WHERE id = ?').all(Number(n));
    if (byId.length) return byId;
  }
  return db.prepare(
    `SELECT * FROM courses WHERE name LIKE ? OR course_code LIKE ? ORDER BY (workflow_state='available') DESC, name`,
  ).all(`%${n}%`, `%${n}%`);
}

const courseLine = (c) => ({
  id: c.id, name: c.name, code: c.course_code, url: c.html_url,
  score: c.current_score, grade: c.current_grade,
});

export function buildCanvasTools(db) {
  const listDue = tool(
    'list_due',
    'List assignments and quizzes with due dates in a window. Use for "what is due", "this week", "overdue". Dates are stored UTC and returned with a local America/New_York rendering.',
    {
      within_days: z.number().int().default(14).describe('Days ahead from now. Use a negative number to look backwards.'),
      course: z.string().optional().describe('Course name, code, or id. Omit for all courses.'),
      include_submitted: z.boolean().default(false).describe('Include items already submitted or graded.'),
      limit: z.number().int().default(50),
    },
    async ({ within_days, course, include_submitted, limit }) => {
      const now = new Date();
      const end = new Date(now.getTime() + within_days * 86400000);
      const [lo, hi] = within_days >= 0 ? [now, end] : [end, now];
      const ids = course ? findCourses(db, course).map((c) => c.id) : null;
      if (course && !ids.length) return text(`No course matching "${course}".`);
      const filter = ids ? `AND a.course_id IN (${ids.join(',')})` : '';
      const rows = db.prepare(`
        SELECT a.id, a.name, a.due_at, a.points_possible, a.html_url, a.submission_types,
               c.name AS course, c.course_code,
               s.workflow_state, s.submitted_at, s.score, s.grade, s.missing, s.late
        FROM assignments a
        JOIN courses c ON c.id = a.course_id
        LEFT JOIN submissions s ON s.assignment_id = a.id
        WHERE a.due_at IS NOT NULL AND a.due_at BETWEEN ? AND ?
          AND a.published = 1 AND c.workflow_state = 'available' ${filter}
        ORDER BY a.due_at LIMIT ?`).all(lo.toISOString(), hi.toISOString(), limit);
      const out = rows
        .filter((r) => include_submitted || !['submitted', 'graded'].includes(r.workflow_state))
        .map((r) => ({
          id: r.id, course: r.course_code || r.course, name: r.name,
          due_utc: r.due_at, due_local: localTime(r.due_at),
          points: r.points_possible, status: r.workflow_state || 'unsubmitted',
          missing: !!r.missing, late: !!r.late,
          submit_via: JSON.parse(r.submission_types || '[]').join(','),
          url: r.html_url,
        }));
      return json({ now_utc: now.toISOString(), window_days: within_days, count: out.length, items: out });
    },
  );

  const search = tool(
    'search',
    'Full-text search across assignment descriptions, announcements, discussions, page bodies, syllabi, quiz descriptions, module items and file names. Use this whenever the question is about content rather than dates.',
    {
      query: z.string().describe('FTS5 query. Plain words are AND-ed; use "quoted phrases" for exact phrases; OR is supported.'),
      kind: z.enum(['assignment', 'announcement', 'discussion', 'page', 'syllabus', 'quiz', 'file', 'module']).optional(),
      course: z.string().optional().describe('Course name, code, or id.'),
      limit: z.number().int().default(10),
    },
    async ({ query, kind, course, limit }) => {
      const clauses = [];
      const params = [query];
      if (kind) { clauses.push('d.kind = ?'); params.push(kind); }
      if (course) {
        const ids = findCourses(db, course).map((c) => c.id);
        if (!ids.length) return text(`No course matching "${course}".`);
        clauses.push(`d.course_id IN (${ids.join(',')})`);
      }
      const where = clauses.length ? 'AND ' + clauses.join(' AND ') : '';
      let rows;
      try {
        rows = db.prepare(`
          SELECT d.kind, d.ref_id, d.course_name, d.title, d.url, d.body,
                 snippet(docs_fts, 1, '«', '»', '…', 24) AS snip
          FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
          WHERE docs_fts MATCH ? ${where} ORDER BY rank LIMIT ?`).all(...params, limit);
      } catch (e) {
        return text(`Search syntax error: ${e.message}. Try plain words or a "quoted phrase".`);
      }
      if (!rows.length) return text(`No matches for ${JSON.stringify(query)}${kind ? ` (kind=${kind})` : ''}.`);
      return json(rows.map((r) => ({
        kind: r.kind, id: r.ref_id, course: r.course_name, title: r.title,
        match: r.snip?.replace(/\s+/g, ' '), url: r.url,
      })));
    },
  );

  const getCourse = tool(
    'get_course',
    'Everything about one course: grade, teachers, syllabus, and counts. Optionally include full lists of assignments, announcements, modules, pages or files.',
    {
      course: z.string().describe('Course name, code, or id.'),
      include: z.array(z.enum(['syllabus', 'assignments', 'announcements', 'modules', 'pages', 'files', 'quizzes'])).default([]),
    },
    async ({ course, include }) => {
      const matches = findCourses(db, course);
      if (!matches.length) return text(`No course matching "${course}".`);
      if (matches.length > 1 && !/^\d+$/.test(course)) {
        return json({ ambiguous: true, matches: matches.map(courseLine) });
      }
      const c = matches[0];
      const out = {
        ...courseLine(c), term: c.term_name, state: c.workflow_state,
        teachers: JSON.parse(c.teachers || '[]'),
        counts: {},
      };
      for (const [t, col] of [['assignments', 'id'], ['discussions', 'id'], ['pages', 'page_id'], ['files', 'id'], ['modules', 'id'], ['quizzes', 'id']]) {
        out.counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE course_id = ?`).get(c.id).n;
      }
      if (include.includes('syllabus')) out.syllabus = truncate(c.syllabus_text, 8000) || '(none published)';
      if (include.includes('assignments')) {
        out.assignments = db.prepare(`SELECT id,name,due_at,points_possible,html_url FROM assignments WHERE course_id=? ORDER BY due_at IS NULL, due_at`).all(c.id)
          .map((a) => ({ ...a, due_local: localTime(a.due_at) }));
      }
      if (include.includes('announcements')) {
        out.announcements = db.prepare(`SELECT id,title,posted_at,author,html_url,substr(message_text,1,400) preview FROM discussions WHERE course_id=? AND kind='announcement' ORDER BY posted_at DESC LIMIT 40`).all(c.id);
      }
      if (include.includes('modules')) {
        out.modules = db.prepare(`SELECT name,position,state,items FROM modules WHERE course_id=? ORDER BY position`).all(c.id)
          .map((m) => ({ ...m, items: JSON.parse(m.items || '[]') }));
      }
      if (include.includes('pages')) out.pages = db.prepare(`SELECT page_id,title,html_url,updated_at FROM pages WHERE course_id=?`).all(c.id);
      if (include.includes('files')) out.files = db.prepare(`SELECT id,display_name,folder,content_type,size,html_url FROM files WHERE course_id=? ORDER BY updated_at DESC LIMIT 200`).all(c.id);
      if (include.includes('quizzes')) out.quizzes = db.prepare(`SELECT id,title,due_at,points_possible,question_count,time_limit,html_url FROM quizzes WHERE course_id=?`).all(c.id);
      return json(out);
    },
  );

  const getItem = tool(
    'get_item',
    'Full text of one item: an assignment (description, rubric-ish details, your submission state), an announcement or discussion, a page, or a quiz. Look up by numeric id from a previous result, or by name.',
    {
      kind: z.enum(['assignment', 'announcement', 'discussion', 'page', 'quiz']),
      id_or_name: z.string(),
      course: z.string().optional().describe('Narrows a name lookup.'),
    },
    async ({ kind, id_or_name, course }) => {
      const numeric = /^\d+$/.test(id_or_name.trim());
      const courseIds = course ? findCourses(db, course).map((c) => c.id) : null;
      const cf = courseIds?.length ? `AND t.course_id IN (${courseIds.join(',')})` : '';
      const spec = {
        assignment: ['assignments', 'id', 'name'],
        announcement: ['discussions', 'id', 'title'],
        discussion: ['discussions', 'id', 'title'],
        page: ['pages', 'page_id', 'title'],
        quiz: ['quizzes', 'id', 'title'],
      }[kind];
      const [table, pk, titleCol] = spec;
      const kindFilter = kind === 'announcement' ? `AND t.kind='announcement'` : kind === 'discussion' ? `AND t.kind='discussion'` : '';
      const rows = numeric
        ? db.prepare(`SELECT t.*, c.name AS course_name FROM ${table} t JOIN courses c ON c.id=t.course_id WHERE t.${pk}=? ${cf}`).all(Number(id_or_name))
        : db.prepare(`SELECT t.*, c.name AS course_name FROM ${table} t JOIN courses c ON c.id=t.course_id WHERE t.${titleCol} LIKE ? ${kindFilter} ${cf} LIMIT 6`).all(`%${id_or_name}%`);
      if (!rows.length) return text(`No ${kind} matching "${id_or_name}".`);
      if (rows.length > 1) {
        return json({ ambiguous: true, matches: rows.map((r) => ({ id: r[pk], course: r.course_name, title: r[titleCol], url: r.html_url })) });
      }
      const r = rows[0];
      const body = truncate(r.description_text ?? r.message_text ?? r.body_text ?? '', 12000);
      const out = {
        kind, id: r[pk], course: r.course_name, title: r[titleCol], url: r.html_url, body: body || '(no body)',
      };
      if (kind === 'assignment') {
        out.due_utc = r.due_at; out.due_local = localTime(r.due_at);
        out.points_possible = r.points_possible;
        out.submit_via = JSON.parse(r.submission_types || '[]');
        out.unlock_at = r.unlock_at; out.lock_at = r.lock_at;
        const s = db.prepare('SELECT * FROM submissions WHERE assignment_id=?').get(r.id);
        if (s) out.my_submission = {
          state: s.workflow_state, submitted_at: s.submitted_at, score: s.score, grade: s.grade,
          late: !!s.late, missing: !!s.missing, excused: !!s.excused,
          comments: JSON.parse(s.comments || '[]'),
        };
      }
      if (kind === 'quiz') Object.assign(out, {
        due_utc: r.due_at, due_local: localTime(r.due_at), points_possible: r.points_possible,
        question_count: r.question_count, time_limit_minutes: r.time_limit,
      });
      if (kind === 'announcement' || kind === 'discussion') Object.assign(out, {
        posted_at: r.posted_at, posted_local: localTime(r.posted_at), author: r.author,
      });
      return json(out);
    },
  );

  const grades = tool(
    'grades',
    'Current score per course, plus graded and ungraded work. Use for "how am I doing", "what is my grade", "what has not been graded".',
    { course: z.string().optional(), show_items: z.boolean().default(false).describe('Include per-assignment scores.') },
    async ({ course, show_items }) => {
      const courses = course ? findCourses(db, course) : db.prepare(`SELECT * FROM courses WHERE workflow_state='available' ORDER BY name`).all();
      if (!courses.length) return text(`No course matching "${course}".`);
      const out = courses.map((c) => {
        const agg = db.prepare(`
          SELECT SUM(s.workflow_state='graded') graded, SUM(s.workflow_state='submitted') awaiting,
                 SUM(s.missing=1) missing
          FROM submissions s WHERE s.course_id = ?`).get(c.id);
        const row = {
          course: c.name, code: c.course_code, current_score: c.current_score, current_grade: c.current_grade,
          graded_count: agg.graded || 0, awaiting_grade: agg.awaiting || 0, missing: agg.missing || 0,
          url: `${c.html_url}/grades`,
        };
        if (show_items) {
          row.items = db.prepare(`
            SELECT a.name, a.points_possible, s.score, s.grade, s.workflow_state, s.late, s.missing, a.html_url
            FROM assignments a LEFT JOIN submissions s ON s.assignment_id=a.id
            WHERE a.course_id=? AND a.published=1 AND (a.points_possible > 0 OR s.score IS NOT NULL)
            ORDER BY a.due_at IS NULL, a.due_at`).all(c.id);
        }
        return row;
      });
      return json(out);
    },
  );

  const recentChanges = tool(
    'recent_changes',
    'What changed in Canvas recently: new assignments, edited descriptions, moved due dates, new grades, removed items. Use for "what is new", "did anything change", "what did I miss".',
    {
      since_days: z.number().int().default(7),
      course: z.string().optional(),
      kind: z.enum(['new', 'updated', 'due_date_moved', 'graded', 'removed']).optional(),
      limit: z.number().int().default(60),
    },
    async ({ since_days, course, kind, limit }) => {
      const since = new Date(Date.now() - since_days * 86400000).toISOString();
      const clauses = ['ch.detected_at >= ?'];
      const params = [since];
      if (kind) { clauses.push('ch.kind = ?'); params.push(kind); }
      if (course) {
        const ids = findCourses(db, course).map((c) => c.id);
        if (!ids.length) return text(`No course matching "${course}".`);
        clauses.push(`ch.course_id IN (${ids.join(',')})`);
      }
      const rows = db.prepare(`
        SELECT ch.*, c.name AS course_name FROM changes ch LEFT JOIN courses c ON c.id = ch.course_id
        WHERE ${clauses.join(' AND ')} ORDER BY ch.detected_at DESC, ch.id DESC LIMIT ?`).all(...params, limit);
      if (!rows.length) {
        const last = db.prepare(`SELECT value FROM meta WHERE key='last_sync_at'`).get()?.value;
        return text(`No recorded changes in the last ${since_days} days. Last sync: ${last || 'never'}.`);
      }
      return json(rows.map((r) => ({
        at: r.detected_at, what: r.kind, entity: r.entity, course: r.course_name,
        title: r.title, diff: r.detail ? JSON.parse(r.detail) : undefined, url: r.html_url,
      })));
    },
  );

  const listCourses = tool(
    'list_courses',
    'List enrolled courses with ids, codes and current scores. Call this first when you need to know which courses exist.',
    { include_inactive: z.boolean().default(false) },
    async ({ include_inactive }) => {
      const rows = db.prepare(
        `SELECT * FROM courses ${include_inactive ? '' : `WHERE workflow_state='available'`} ORDER BY name`,
      ).all();
      return json(rows.map((c) => ({ ...courseLine(c), term: c.term_name, state: c.workflow_state })));
    },
  );

  return createSdkMcpServer({
    name: 'canvas',
    version: '0.1.0',
    instructions: 'Read-only access to the user\'s mirrored Georgia Tech Canvas data in SQLite.',
    tools: [listCourses, listDue, search, getCourse, getItem, grades, recentChanges],
  });
}

export const CANVAS_TOOL_NAMES = [
  'list_courses', 'list_due', 'search', 'get_course', 'get_item', 'grades', 'recent_changes',
].map((n) => `mcp__canvas__${n}`);
