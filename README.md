# CanvasGPT

A private chat website over your Canvas data, running on your
Claude Code subscription. The model gets SQL-backed tools, not a dump of your
data in the prompt.

## Run it

```bash
npm install
cp .env.example .env        # then set APP_PASSWORD, CANVAS_HOST, MCP_TOKEN
npm start                   # http://localhost:3111
```

Log in with whatever you set as `APP_PASSWORD`. Then paste a Canvas session
cookie at `/settings` and the first sync starts — see **Live sync** below.

`CANVAS_HOST` defaults to Georgia Tech's Canvas; point it at your own
institution's Instructure host to use this elsewhere.

## LLM auth

Locally it uses your logged-in `claude` CLI, so there is nothing to configure.
For a deploy, run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` in the
environment. `ANTHROPIC_API_KEY` also works if you'd rather meter it.

## Use it as a Claude connector

The same seven read-only tools are served over MCP at `/mcp`, so Claude can
query this mirror directly. The endpoint is **disabled unless `MCP_TOKEN` is
set** — an unauthenticated Canvas mirror on a public URL hands a stranger your
coursework.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # put in MCP_TOKEN
claude mcp add --transport http canvas https://<your-host>/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

The connector is stateless (a fresh server per request, no sessions to leak),
read-only (every tool advertises `readOnlyHint`), and carries its own bearer
credential — the app's `APP_PASSWORD` session cookie does not grant access to
`/mcp`, and the MCP token does not grant access to the app.

Freshness comes from the existing scheduler: `SYNC_INTERVAL_HOURS` (default 12)
re-polls Canvas, so a connector query always reads the last sync. There is no
separate polling path to configure.

**Distribution caveat:** this mirrors *your* enrollments behind *your* Canvas
cookie. Sharing your URL and token shares your coursework. To give it to someone
else, they run their own instance with their own cookie.

## Verifying the mirror

`/verify` re-fetches every active course from Canvas and diffs it against
SQLite, so a sync that silently stored nothing is visible rather than implied.
It also reports which resources the last sync could not read, and which were
recovered through module items after their index was blocked.

## What the model can do

Seven read-only tools over SQLite, and nothing else — no filesystem, no bash,
no web access, no built-in Claude Code tools at all:

| tool | for |
| --- | --- |
| `list_courses` | which courses exist, with ids and scores |
| `list_due` | what's due in a window, per course, submitted or not |
| `search` | FTS5 over assignment descriptions, announcements, pages, syllabi, quizzes, module items, filenames |
| `get_course` | one course: grade, teachers, syllabus, assignment/announcement/module lists |
| `get_item` | full text of one assignment / announcement / page / quiz, plus your submission state |
| `grades` | current score per course, what's ungraded, what's missing |
| `recent_changes` | reads the `changes` table |

Every turn tells the model today's date, that timestamps are UTC, that you're in
America/New_York, and that it must cite the Canvas `html_url`.

## What's in the database

From `canvas-dump-2026-09-01.json`: 36 courses, 851 assignments, 886
announcements, 851 submissions, 212 quizzes, 226 modules, 97 pages, 1984 files.
HTML bodies are kept in full *and* converted to clean text for indexing.

## The diff engine

`ingestDump()` hashes every content row and, on re-ingest, writes a row into
`changes` classifying what happened: `new`, `updated` (with a field-level
before/after diff), `due_date_moved`, `graded`, `removed`. A first ingest into an
empty database records nothing — a fresh mirror is not news.

Verified by mutating a copy of the real dump: all five classifications fire
correctly, and a re-ingest of unchanged data produces zero rows.

## Live sync

Runs on boot and then every 12 hours (`SYNC_INTERVAL_HOURS`). Each run fetches
every endpoint in the brief for every active course, assembles the same object
shape `canvas-dump.js` produces, and feeds it to the diff engine — so every
sync after the first writes to `changes`.

The client (`src/canvas.js`) issues **GET requests only**, strips `while(1);`,
follows `Link: rel="next"` with `per_page=100`, and treats 403/404 as normal
(logged, skipped, run continues). The cookie lives in a private class field, is
stored in SQLite rather than a file, and is never logged, returned, or handed to
the chat model.

**When the cookie dies** — you log out, or a few weeks pass — Canvas answers 401
or serves the SSO page. The sync marks itself `stalled`, keeps serving the last
good data, and the chat UI shows a red banner linking to `/settings`, where you
paste a fresh cookie and it re-syncs immediately. No redeploy.

### Copying the cookie

1. Open `gatech.instructure.com` in Chrome, logged in.
2. `Cmd+Option+I` → **Network** tab.
3. Reload. Click the first request in the list.
4. **Request Headers** → find the `cookie:` line.
5. Right-click → **Copy value**, paste into `/settings`.

## Tests

```bash
npm test
```

47 tests against a mock Canvas server that reproduces the real quirks: the
`while(1);` prefix on every response, Link-header pagination, 403 on locked
resources, 404 on a disabled feature's index (while individual objects still
resolve — the gap recovery exists to close), and bare 429 throttling.

- **Sync** (`test/sync.test.js`) — prefix strip, pagination with no duplicates,
  GET-only enforcement, a 403/404 midway not aborting the run, an expired cookie
  stalling while old data survives, the cookie never reaching an error or status
  payload, an unchanged re-sync recording nothing, all five diff
  classifications, and a locked resource never read as a deletion while a
  genuine deletion still is.
- **Verification and recovery** (`test/verify.test.js`) — a clean database
  verifying clean; an added, edited or deleted item upstream being classified
  correctly; files and pages recovered through module items when their index is
  blocked; every reply in a thread stored with its parent, depth and author;
  replies being full-text searchable; threads without replies never fetched; a
  429 retried rather than dropping a collection; and Canvas's string ids
  matching SQLite's integer ids.
- **Connector** (`test/mcp.test.js`) — the endpoint failing closed with no
  token, rejecting prefixes/suffixes/wrong schemes, leaking nothing on refusal,
  exposing exactly the local agent's tools all marked read-only, and surviving
  repeated connection churn.

## Not built yet

- **iCal fallback** (`CANVAS_ICS_URL`) for due dates when the cookie is stale.
- **Dockerfile, `railway.json`, deploy.**

## Files

```
src/schema.sql   tables + FTS5 index
src/ingest.js    dump -> SQLite, with the diff engine
src/tools.js     the seven tools the model gets (shared by chat and connector)
src/verify.js    live re-fetch and diff against SQLite
src/mcp.js       remote MCP endpoint for Claude connectors
src/agent.js     Claude Agent SDK wiring + system prompt
src/server.js    password gate, SSE chat streaming, session storage
public/          login page, chat UI, and the verification page
```

`.gitignore` covers `data/`, `.env`, and `canvas-dump-*.json` — no Canvas
credential or personal data is committable.
