PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT,
  course_code TEXT,
  term_name TEXT,
  workflow_state TEXT,
  start_at TEXT,
  end_at TEXT,
  time_zone TEXT,
  teachers TEXT,
  syllabus_html TEXT,
  syllabus_text TEXT,
  current_score REAL,
  current_grade TEXT,
  final_score REAL,
  html_url TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  course_id INTEGER,
  name TEXT,
  description_html TEXT,
  description_text TEXT,
  due_at TEXT,
  unlock_at TEXT,
  lock_at TEXT,
  points_possible REAL,
  submission_types TEXT,
  group_name TEXT,
  published INTEGER,
  is_quiz INTEGER,
  html_url TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assign_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_assign_due ON assignments(due_at);

CREATE TABLE IF NOT EXISTS submissions (
  assignment_id INTEGER PRIMARY KEY,
  course_id INTEGER,
  score REAL,
  grade TEXT,
  entered_score REAL,
  submitted_at TEXT,
  graded_at TEXT,
  workflow_state TEXT,
  late INTEGER,
  missing INTEGER,
  excused INTEGER,
  attempt INTEGER,
  comments TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_course ON submissions(course_id);

CREATE TABLE IF NOT EXISTS discussions (
  id INTEGER PRIMARY KEY,
  course_id INTEGER,
  kind TEXT,
  title TEXT,
  message_html TEXT,
  message_text TEXT,
  posted_at TEXT,
  last_reply_at TEXT,
  author TEXT,
  html_url TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_disc_course ON discussions(course_id, kind);
CREATE INDEX IF NOT EXISTS idx_disc_posted ON discussions(posted_at);

CREATE TABLE IF NOT EXISTS pages (
  page_id INTEGER PRIMARY KEY,
  course_id INTEGER,
  title TEXT,
  url TEXT,
  body_html TEXT,
  body_text TEXT,
  front_page INTEGER,
  updated_at TEXT,
  html_url TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pages_course ON pages(course_id);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  course_id INTEGER,
  display_name TEXT,
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  folder TEXT,
  updated_at TEXT,
  url TEXT,
  html_url TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_course ON files(course_id);

CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY,
  course_id INTEGER,
  name TEXT,
  position INTEGER,
  state TEXT,
  items TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id);

CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY,
  course_id INTEGER,
  title TEXT,
  description_html TEXT,
  description_text TEXT,
  quiz_type TEXT,
  due_at TEXT,
  unlock_at TEXT,
  lock_at TEXT,
  points_possible REAL,
  question_count INTEGER,
  time_limit INTEGER,
  published INTEGER,
  html_url TEXT,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_quiz_course ON quizzes(course_id);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at TEXT,
  kind TEXT,
  entity TEXT,
  entity_id INTEGER,
  course_id INTEGER,
  title TEXT,
  detail TEXT,
  html_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_at ON changes(detected_at);

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  ref_id INTEGER,
  course_id INTEGER,
  course_name TEXT,
  title TEXT,
  url TEXT,
  body TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_ref ON docs(kind, ref_id);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, content='docs', content_rowid='id', tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  updated_at TEXT,
  title TEXT,
  sdk_session_id TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  role TEXT,
  content TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON chat_messages(session_id, id);

-- Per-course, per-resource reachability from the last sync. Without this the
-- reason a course has no files (locked vs. feature off vs. genuinely empty)
-- lives only in the sync log and is lost on restart.
CREATE TABLE IF NOT EXISTS resource_status (
  course_id INTEGER,
  resource TEXT,
  ok INTEGER,
  http_status INTEGER,
  row_count INTEGER,
  recovered INTEGER DEFAULT 0,
  checked_at TEXT,
  PRIMARY KEY (course_id, resource)
);

-- Individual replies inside a discussion or announcement thread. The topic list
-- endpoints return only the opening post; the thread body needs a per-topic
-- fetch, so without this table every reply in every course is invisible.
CREATE TABLE IF NOT EXISTS discussion_entries (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER,
  course_id INTEGER,
  parent_id INTEGER,
  depth INTEGER,
  author TEXT,
  author_id INTEGER,
  message_html TEXT,
  message_text TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted INTEGER,
  content_hash TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_topic ON discussion_entries(topic_id);
CREATE INDEX IF NOT EXISTS idx_entries_course ON discussion_entries(course_id);
