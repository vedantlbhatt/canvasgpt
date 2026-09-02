import { openDb, setMeta } from './db.js';
import { htmlToText, hash, nowIso } from './util.js';
import fs from 'node:fs';

const HOST = () => process.env.CANVAS_HOST || 'https://gatech.instructure.com';

/**
 * Upsert a row and record what changed. Returns 'new' | 'updated' | 'unchanged'
 * (plus a more specific kind when we can classify it: due_date_moved, graded).
 */
function upsert(db, ctx, table, pk, row, opts) {
  const { entity, courseId, title, url, tracked } = opts;
  // Track what this run saw, by id. Comparing last_seen_at timestamps instead
  // would miss deletions whenever two syncs land in the same millisecond.
  (ctx.seen[table] ??= new Set()).add(row[pk]);
  const digest = hash(Object.fromEntries(tracked.map((f) => [f, row[f] ?? null])));
  const existing = db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(row[pk]);
  const cols = Object.keys(row);

  if (!existing) {
    db.prepare(
      `INSERT INTO ${table} (${cols.join(',')}, content_hash, last_seen_at)
       VALUES (${cols.map((c) => '@' + c).join(',')}, @__hash, @__seen)`,
    ).run({ ...row, __hash: digest, __seen: ctx.runAt });
    recordChange(db, ctx, { kind: 'new', entity, entity_id: row[pk], course_id: courseId, title, detail: null, html_url: url });
    return 'new';
  }

  db.prepare(`UPDATE ${table} SET last_seen_at = ? WHERE ${pk} = ?`).run(ctx.runAt, row[pk]);
  if (existing.content_hash === digest) return 'unchanged';

  const diffs = [];
  for (const f of tracked) {
    const before = existing[f] ?? null;
    const after = row[f] ?? null;
    if (String(before ?? '') !== String(after ?? '')) diffs.push({ field: f, before, after });
  }

  let kind = 'updated';
  if (diffs.some((d) => d.field === 'due_at')) kind = 'due_date_moved';
  else if (diffs.some((d) => ['score', 'grade', 'graded_at', 'entered_score'].includes(d.field))) kind = 'graded';

  db.prepare(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, content_hash = @__hash, last_seen_at = @__seen
     WHERE ${pk} = @${pk}`,
  ).run({ ...row, __hash: digest, __seen: ctx.runAt });

  recordChange(db, ctx, {
    kind, entity, entity_id: row[pk], course_id: courseId, title,
    detail: JSON.stringify(diffs.map((d) => ({
      field: d.field,
      before: clip(d.before),
      after: clip(d.after),
    }))),
    html_url: url,
  });
  return kind;
}

const clip = (v) => (typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '…' : v);

function recordChange(db, ctx, c) {
  if (ctx.firstRun) return; // a fresh database is not "news"
  db.prepare(
    `INSERT INTO changes (detected_at, kind, entity, entity_id, course_id, title, detail, html_url)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(ctx.runAt, c.kind, c.entity, c.entity_id, c.course_id, c.title, c.detail, c.html_url);
}

function markRemoved(db, ctx, table, pk, entity, titleCol, courseIds, resourceKeys) {
  if (ctx.firstRun) return;
  // Only courses whose relevant resources all came back cleanly this run.
  const ids = courseIds.filter((cid) => {
    const missing = ctx.unavailable[cid] || [];
    return !resourceKeys.some((k) => missing.includes(k));
  });
  if (!ids.length) return;
  const seen = ctx.seen[table] || new Set();
  const rows = db.prepare(
    `SELECT ${pk} AS id, course_id, ${titleCol} AS title, html_url FROM ${table}
     WHERE course_id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids).filter((r) => !seen.has(r.id));
  for (const r of rows) {
    recordChange(db, ctx, {
      kind: 'removed', entity, entity_id: r.id, course_id: r.course_id,
      title: r.title, detail: null, html_url: r.html_url,
    });
  }
}

function addDoc(db, d) {
  db.prepare(
    `INSERT INTO docs (kind, ref_id, course_id, course_name, title, url, body) VALUES (?,?,?,?,?,?,?)`,
  ).run(d.kind, d.ref_id, d.course_id, d.course_name, d.title, d.url, d.body);
}

/** Load a full Canvas dump (browser-console or headless format) into SQLite. */
export function ingestDump(db, dump) {
  const runAt = nowIso();
  const firstRun = db.prepare('SELECT COUNT(*) n FROM courses').get().n === 0;
  const ctx = { runAt, firstRun, seen: {}, unavailable: {} };
  const host = dump.host || HOST();
  const courses = dump.courses || [];
  const courseIds = courses.map((c) => c.id);
  for (const c of courses) ctx.unavailable[c.id] = c.__unavailable || [];
  // Reachability is only known on a live sync; a replayed dump carries none, so
  // leave whatever the last live run recorded rather than blanking it.
  const reachability = courses.flatMap((c) => (c.__reachability || []).map((r) => ({ ...r, course_id: c.id })));
  const stats = { courses: 0, assignments: 0, announcements: 0, discussions: 0, pages: 0, files: 0, quizzes: 0, modules: 0, submissions: 0, replies: 0, changes: 0 };

  const run = db.transaction(() => {
    db.prepare('DELETE FROM docs').run();

    const putReach = db.prepare(
      `INSERT INTO resource_status (course_id, resource, ok, http_status, row_count, recovered, checked_at)
       VALUES (@course_id, @resource, @ok, @http_status, @row_count, @recovered, @checked_at)
       ON CONFLICT(course_id, resource) DO UPDATE SET
         ok=excluded.ok, http_status=excluded.http_status, row_count=excluded.row_count,
         recovered=excluded.recovered, checked_at=excluded.checked_at`,
    );
    for (const r of reachability) putReach.run({ ...r, ok: r.ok ? 1 : 0, recovered: r.recovered ?? 0, checked_at: runAt });

    for (const c of courses) {
      const cUrl = `${host}/courses/${c.id}`;
      const enr = (c.enrollments || []).find((e) => e.type === 'student') || (c.enrollments || [])[0] || {};
      const syllabusHtml = c.syllabus_body || c.syllabus || null;
      upsert(db, ctx, 'courses', 'id', {
        id: c.id,
        name: c.name ?? null,
        course_code: c.course_code ?? null,
        term_name: c.term?.name ?? null,
        workflow_state: c.workflow_state ?? null,
        start_at: c.start_at ?? null,
        end_at: c.end_at ?? null,
        time_zone: c.time_zone ?? null,
        teachers: JSON.stringify((c.teachers || []).map((t) => t.name)),
        syllabus_html: syllabusHtml,
        syllabus_text: htmlToText(syllabusHtml),
        current_score: enr.computed_current_score ?? null,
        current_grade: enr.computed_current_grade ?? enr.computed_current_letter_grade ?? null,
        final_score: enr.computed_final_score ?? null,
        html_url: cUrl,
      }, {
        entity: 'course', courseId: c.id, title: c.name, url: cUrl,
        tracked: ['name', 'workflow_state', 'syllabus_text', 'current_score', 'current_grade'],
      });
      stats.courses++;

      if (syllabusHtml) {
        addDoc(db, { kind: 'syllabus', ref_id: c.id, course_id: c.id, course_name: c.name, title: `${c.name} syllabus`, url: `${cUrl}/assignments/syllabus`, body: htmlToText(syllabusHtml) });
      }

      const groupById = new Map((c.assignment_groups || []).map((g) => [g.id, g.name]));

      for (const a of c.assignments || []) {
        const url = a.html_url || `${cUrl}/assignments/${a.id}`;
        upsert(db, ctx, 'assignments', 'id', {
          id: a.id,
          course_id: c.id,
          name: a.name ?? null,
          description_html: a.description ?? null,
          description_text: htmlToText(a.description),
          due_at: a.due_at ?? null,
          unlock_at: a.unlock_at ?? null,
          lock_at: a.lock_at ?? null,
          points_possible: a.points_possible ?? null,
          submission_types: JSON.stringify(a.submission_types || []),
          group_name: groupById.get(a.assignment_group_id) ?? null,
          published: a.published ? 1 : 0,
          is_quiz: a.is_quiz_assignment || a.quiz_id ? 1 : 0,
          html_url: url,
        }, {
          entity: 'assignment', courseId: c.id, title: a.name, url,
          tracked: ['name', 'description_text', 'due_at', 'points_possible', 'published', 'lock_at'],
        });
        stats.assignments++;
        addDoc(db, { kind: 'assignment', ref_id: a.id, course_id: c.id, course_name: c.name, title: a.name, url, body: htmlToText(a.description) });

        const sub = a.submission;
        if (sub) upsertSubmission(db, ctx, c, sub, a.id, { name: a.name, html_url: url });
      }

      for (const s of c.submissions || []) {
        if (!(c.assignments || []).some((a) => a.id === s.assignment_id && a.submission)) {
          upsertSubmission(db, ctx, c, s, s.assignment_id);
        }
      }
      stats.submissions += (c.submissions || []).length;

      const topics = [
        ...(c.announcements || []).map((t) => ['announcement', t]),
        ...(c.discussions || []).map((t) => ['discussion', t]),
      ];
      const seenTopics = new Set();
      for (const [kind, t] of topics) {
        if (seenTopics.has(t.id)) continue;
        seenTopics.add(t.id);
        const url = t.html_url || `${cUrl}/discussion_topics/${t.id}`;
        upsert(db, ctx, 'discussions', 'id', {
          id: t.id,
          course_id: c.id,
          kind,
          title: t.title ?? null,
          message_html: t.message ?? null,
          message_text: htmlToText(t.message),
          posted_at: t.posted_at ?? t.created_at ?? null,
          last_reply_at: t.last_reply_at ?? null,
          author: t.user_name ?? t.author?.display_name ?? null,
          html_url: url,
        }, {
          entity: kind, courseId: c.id, title: t.title, url,
          tracked: ['title', 'message_text', 'posted_at'],
        });
        if (kind === 'announcement') stats.announcements++; else stats.discussions++;
        addDoc(db, { kind, ref_id: t.id, course_id: c.id, course_name: c.name, title: t.title, url, body: htmlToText(t.message) });
      }

      // Replies inside each thread. Indexed for search too — the answer to a
      // question is often in a reply, not in the opening post.
      for (const e of c.discussion_entries || []) {
        if (e?.id == null) continue;
        const url = `${cUrl}/discussion_topics/${e.topic_id}`;
        const body = htmlToText(e.message_html);
        upsert(db, ctx, 'discussion_entries', 'id', {
          id: e.id,
          topic_id: e.topic_id,
          course_id: c.id,
          parent_id: e.parent_id ?? null,
          depth: e.depth ?? 0,
          author: e.author ?? null,
          author_id: e.author_id ?? null,
          message_html: e.message_html ?? null,
          message_text: body,
          created_at: e.created_at ?? null,
          updated_at: e.updated_at ?? null,
          deleted: e.deleted ?? 0,
        }, {
          entity: 'reply', courseId: c.id, title: `reply by ${e.author || 'someone'}`, url,
          tracked: ['message_text', 'author', 'deleted'],
        });
        stats.replies++;
        if (body) {
          addDoc(db, {
            kind: 'reply', ref_id: e.id, course_id: c.id, course_name: c.name,
            title: `Reply by ${e.author || 'unknown'}`, url, body,
          });
        }
      }

      const pages = [...(c.pages || [])];
      if (c.front_page && !pages.some((p) => p.page_id === c.front_page.page_id)) pages.push(c.front_page);
      for (const p of pages) {
        if (!p?.page_id) continue;
        const url = p.html_url || `${cUrl}/pages/${p.url}`;
        upsert(db, ctx, 'pages', 'page_id', {
          page_id: p.page_id,
          course_id: c.id,
          title: p.title ?? null,
          url: p.url ?? null,
          body_html: p.body ?? null,
          body_text: htmlToText(p.body),
          front_page: p.front_page ? 1 : 0,
          updated_at: p.updated_at ?? null,
          html_url: url,
        }, {
          entity: 'page', courseId: c.id, title: p.title, url,
          tracked: ['title', 'body_text'],
        });
        stats.pages++;
        addDoc(db, { kind: 'page', ref_id: p.page_id, course_id: c.id, course_name: c.name, title: p.title, url, body: htmlToText(p.body) });
      }

      const folderById = new Map((c.folders || []).map((f) => [f.id, f.full_name || f.name]));
      for (const f of c.files || []) {
        const url = `${cUrl}/files/${f.id}`;
        upsert(db, ctx, 'files', 'id', {
          id: f.id,
          course_id: c.id,
          display_name: f.display_name ?? f.filename ?? null,
          filename: f.filename ?? null,
          content_type: f['content-type'] ?? f.content_type ?? null,
          size: f.size ?? null,
          folder: folderById.get(f.folder_id) ?? null,
          updated_at: f.updated_at ?? null,
          url: f.url ?? null,
          html_url: url,
        }, {
          entity: 'file', courseId: c.id, title: f.display_name, url,
          tracked: ['display_name', 'size', 'updated_at'],
        });
        stats.files++;
        addDoc(db, { kind: 'file', ref_id: f.id, course_id: c.id, course_name: c.name, title: f.display_name ?? f.filename, url, body: [folderById.get(f.folder_id), f.display_name, f.filename].filter(Boolean).join(' ') });
      }

      for (const m of c.modules || []) {
        upsert(db, ctx, 'modules', 'id', {
          id: m.id,
          course_id: c.id,
          name: m.name ?? null,
          position: m.position ?? null,
          state: m.state ?? null,
          items: JSON.stringify((m.items || []).map((i) => ({ title: i.title, type: i.type, url: i.html_url }))),
        }, {
          entity: 'module', courseId: c.id, title: m.name, url: `${cUrl}/modules`,
          tracked: ['name', 'items', 'state'],
        });
        stats.modules++;
        addDoc(db, {
          kind: 'module', ref_id: m.id, course_id: c.id, course_name: c.name, title: m.name,
          url: `${cUrl}/modules`, body: (m.items || []).map((i) => i.title).join('\n'),
        });
      }

      for (const q of c.quizzes || []) {
        const url = q.html_url || `${cUrl}/quizzes/${q.id}`;
        upsert(db, ctx, 'quizzes', 'id', {
          id: q.id,
          course_id: c.id,
          title: q.title ?? null,
          description_html: q.description ?? null,
          description_text: htmlToText(q.description),
          quiz_type: q.quiz_type ?? null,
          due_at: q.due_at ?? null,
          unlock_at: q.unlock_at ?? null,
          lock_at: q.lock_at ?? null,
          points_possible: q.points_possible ?? null,
          question_count: q.question_count ?? null,
          time_limit: q.time_limit ?? null,
          published: q.published ? 1 : 0,
          html_url: url,
        }, {
          entity: 'quiz', courseId: c.id, title: q.title, url,
          tracked: ['title', 'description_text', 'due_at', 'points_possible'],
        });
        stats.quizzes++;
        addDoc(db, { kind: 'quiz', ref_id: q.id, course_id: c.id, course_name: c.name, title: q.title, url, body: htmlToText(q.description) });
      }
    }

    for (const [table, pk, entity, titleCol, resources] of [
      ['assignments', 'id', 'assignment', 'name', ['assignments']],
      ['discussions', 'id', 'announcement', 'title', ['announcements', 'discussions']],
      ['pages', 'page_id', 'page', 'title', ['pages']],
      ['quizzes', 'id', 'quiz', 'title', ['quizzes']],
    ]) {
      markRemoved(db, ctx, table, pk, entity, titleCol, courseIds, resources);
    }

    db.prepare(`INSERT INTO docs_fts(docs_fts) VALUES('rebuild')`).run();
    setMeta(db, 'last_sync_at', runAt);
    setMeta(db, 'last_sync_source', dump.__source || 'dump');
    setMeta(db, 'canvas_host', host);
    setMeta(db, 'canvas_fetched_at', dump.fetched_at || runAt);
    if (dump.profile?.name) setMeta(db, 'user_name', dump.profile.name);
    if (dump.profile?.time_zone) setMeta(db, 'user_tz', dump.profile.time_zone);
  });

  run();
  stats.changes = db.prepare('SELECT COUNT(*) n FROM changes WHERE detected_at = ?').get(runAt).n;
  stats.firstRun = firstRun;
  return stats;
}

function upsertSubmission(db, ctx, course, s, assignmentId, known) {
  if (!assignmentId) return;
  const a = known || s.assignment || {};
  const url = a.html_url || `${HOST()}/courses/${course.id}/assignments/${assignmentId}`;
  upsert(db, ctx, 'submissions', 'assignment_id', {
    assignment_id: assignmentId,
    course_id: course.id,
    score: s.score ?? null,
    grade: s.grade ?? null,
    entered_score: s.entered_score ?? null,
    submitted_at: s.submitted_at ?? null,
    graded_at: s.graded_at ?? null,
    workflow_state: s.workflow_state ?? null,
    late: s.late ? 1 : 0,
    missing: s.missing ? 1 : 0,
    excused: s.excused ? 1 : 0,
    attempt: s.attempt ?? null,
    comments: JSON.stringify((s.submission_comments || []).map((c) => ({ author: c.author_name, comment: c.comment, at: c.created_at }))),
  }, {
    entity: 'submission', courseId: course.id, title: a.name ?? `assignment ${assignmentId}`, url,
    tracked: ['score', 'grade', 'workflow_state', 'submitted_at', 'graded_at', 'missing', 'comments'],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node src/ingest.js <canvas-dump.json>');
    process.exit(1);
  }
  const db = openDb();
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t0 = Date.now();
  const stats = ingestDump(db, dump);
  console.log(`ingested in ${((Date.now() - t0) / 1000).toFixed(1)}s`, stats);
}
