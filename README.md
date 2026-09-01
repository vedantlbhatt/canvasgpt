# CanvasGPT

A private chat website over your Georgia Tech Canvas data, running on your
Claude Code subscription. The model gets SQL-backed tools, not a dump of your
data in the prompt.

## Run it

```bash
npm install
node src/ingest.js ~/Downloads/canvas-dump-2026-09-01.json   # already done
npm start                                                    # http://localhost:3111
```

Password is whatever `APP_PASSWORD` is in `.env` (currently `canvas` — change it).

## LLM auth

Locally it uses your logged-in `claude` CLI, so there is nothing to configure.
For a deploy, run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` in the
environment. `ANTHROPIC_API_KEY` also works if you'd rather meter it.

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

14 tests against a mock Canvas server that reproduces the real quirks: the
`while(1);` prefix on every response, Link-header pagination, and 403/404 on
locked resources. Covered: the prefix strip, pagination across three pages with
no duplicates, GET-only enforcement, a 403 and a 404 midway through a run not
aborting it, an expired cookie stalling the sync while the old data survives,
the cookie never appearing in an error or a status payload, an unchanged re-sync
recording nothing, all five diff classifications, and — the one that matters
most for trust — a locked resource never being reported as a deletion, while a
genuine deletion on a readable resource still is.

## Not built yet

- **iCal fallback** (`CANVAS_ICS_URL`) for due dates when the cookie is stale.
- **Dockerfile, `railway.json`, deploy.**

## Files

```
src/schema.sql   tables + FTS5 index
src/ingest.js    dump -> SQLite, with the diff engine
src/tools.js     the seven tools the model gets
src/agent.js     Claude Agent SDK wiring + system prompt
src/server.js    password gate, SSE chat streaming, session storage
public/          login page and chat UI
```

`.gitignore` covers `data/`, `.env`, and `canvas-dump-*.json` — no Canvas
credential or personal data is committable.
