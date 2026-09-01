import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, getMeta } from './db.js';
import { runTurn } from './agent.js';
import { ingestDump } from './ingest.js';
import { startScheduler, runSync, setCookie, syncStatus, getCookie } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '..', '.env'));

// The SDK warns that allowlisted tools skip canUseTool. That is intended here:
// allowedTools IS the allowlist and canUseTool is the deny-by-default backstop.
const origEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = rest.find((r) => typeof r === 'string' && r.startsWith('CLAUDE_SDK')) ?? rest?.[0]?.code;
  if (String(code).includes('CAN_USE_TOOL_SHADOWED')) return;
  return origEmit.call(process, warning, ...rest);
};

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD;
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(PASSWORD || 'dev').digest('hex');
const COOKIE = 'cgpt_session';
const db = openDb();

if (!PASSWORD) {
  console.error('APP_PASSWORD is not set. Copy .env.example to .env and set one.');
  process.exit(1);
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
};

const verify = (token) => {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
};

const parseCookies = (header = '') =>
  Object.fromEntries(header.split(';').map((c) => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

app.use((req, _res, next) => {
  req.session = verify(parseCookies(req.headers.cookie)[COOKIE]);
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, courses: db.prepare('SELECT COUNT(*) n FROM courses').get().n });
});

app.post('/api/login', (req, res) => {
  const given = String(req.body?.password ?? '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return setTimeout(() => res.status(401).json({ error: 'Wrong password.' }), 400);
  }
  const token = sign({ ok: true, exp: Date.now() + 30 * 86400000 });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

const requireAuth = (req, res, next) => (req.session ? next() : res.status(401).json({ error: 'unauthorized' }));

app.get('/api/sync/status', requireAuth, (_req, res) => {
  res.json({ ...syncStatus(db), running: scheduler.isRunning() });
});

// Trigger a sync by hand. Fire-and-forget: the UI polls /api/sync/status.
app.post('/api/sync/now', requireAuth, (_req, res) => {
  if (scheduler.isRunning()) return res.status(409).json({ error: 'A sync is already running.' });
  if (!getCookie(db)) return res.status(400).json({ error: 'No Canvas cookie configured.' });
  scheduler.tick('manual');
  res.json({ started: true });
});

// Accepts a fresh browser cookie. The value is stored in SQLite (gitignored,
// on the Railway volume) and is never read back out by any endpoint.
app.post('/api/settings/cookie', requireAuth, async (req, res) => {
  const cookie = String(req.body?.cookie ?? '').trim();
  if (cookie.length < 20 || !cookie.includes('=')) {
    return res.status(400).json({ error: 'That does not look like a cookie string.' });
  }
  setCookie(db, cookie);
  try {
    const stats = await runSync(db, { log: console.log });
    res.json({ ok: true, stats: { courses: stats.courses, changes: stats.changes } });
  } catch (err) {
    res.status(502).json({ error: syncStatus(db).last_error || 'Sync failed with that cookie.' });
  }
});

app.get('/api/status', requireAuth, (_req, res) => {
  const counts = {};
  for (const t of ['courses', 'assignments', 'discussions', 'pages', 'files', 'quizzes', 'modules', 'changes']) {
    counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  }
  res.json({
    sync: syncStatus(db),
    last_sync_at: getMeta(db, 'last_sync_at'),
    canvas_fetched_at: getMeta(db, 'canvas_fetched_at'),
    user_name: getMeta(db, 'user_name'),
    active_courses: db.prepare(`SELECT COUNT(*) n FROM courses WHERE workflow_state='available'`).get().n,
    counts,
  });
});

app.get('/api/sessions', requireAuth, (_req, res) => {
  res.json(db.prepare('SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT 50').all());
});

app.get('/api/sessions/:id', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT role, content, created_at FROM chat_messages WHERE session_id=? ORDER BY id').all(req.params.id));
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM chat_messages WHERE session_id=?').run(req.params.id);
  db.prepare('DELETE FROM chat_sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  let chatId = req.body?.session_id || null;
  if (!message) return res.status(400).json({ error: 'empty message' });

  const now = new Date().toISOString();
  if (!chatId) {
    chatId = crypto.randomUUID();
    db.prepare('INSERT INTO chat_sessions (id, created_at, updated_at, title) VALUES (?,?,?,?)')
      .run(chatId, now, now, message.slice(0, 70));
  }
  const chat = db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(chatId);
  db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?,?,?,?)')
    .run(chatId, 'user', message, now);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'session', session_id: chatId });

  let answer = '';
  try {
    for await (const ev of runTurn(db, { prompt: message, resumeSessionId: chat?.sdk_session_id || null })) {
      if (ev.type === 'text') { answer += ev.text; send(ev); }
      else if (ev.type === 'tool') send(ev);
      else if (ev.type === 'error') send(ev);
      else if (ev.type === 'done') {
        if (ev.sessionId) db.prepare('UPDATE chat_sessions SET sdk_session_id=?, updated_at=? WHERE id=?').run(ev.sessionId, new Date().toISOString(), chatId);
        send({ type: 'done' });
      }
    }
  } catch (err) {
    console.error('chat error:', err?.message);
    send({ type: 'error', message: err?.message || 'Something broke on the server.' });
  }
  if (answer.trim()) {
    db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?,?,?,?)')
      .run(chatId, 'assistant', answer, new Date().toISOString());
  }
  res.end();
});

app.post('/api/ingest', requireAuth, (req, res) => {
  const file = req.body?.path;
  if (!file || !fs.existsSync(file)) return res.status(400).json({ error: 'dump file not found' });
  try {
    res.json(ingestDump(db, JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', req.session ? 'index.html' : 'login.html'));
});

app.get('/settings', (req, res) => {
  if (!req.session) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'settings.html'));
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.use((req, res) => res.status(404).send('not found'));

const SYNC_HOURS = Number(process.env.SYNC_INTERVAL_HOURS || 12);
const scheduler = startScheduler(db, { hours: SYNC_HOURS, log: (m) => console.log(m) });

app.listen(PORT, '0.0.0.0', () => {
  const active = db.prepare(`SELECT COUNT(*) n FROM courses WHERE workflow_state='available'`).get().n;
  console.log(`CanvasGPT on http://localhost:${PORT}`);
  console.log(`  ${active} active courses, last sync ${getMeta(db, 'last_sync_at') || 'never'}`);
  console.log(getCookie(db)
    ? `  sync every ${SYNC_HOURS}h, first run in a moment`
    : '  no Canvas cookie yet — paste one at /settings to start syncing');
});
