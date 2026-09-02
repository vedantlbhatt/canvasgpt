/**
 * Tests for the remote MCP connector. The endpoint is the one surface that can
 * be reached without the app's session cookie, so most of this is about the
 * auth gate and about it exposing nothing the local agent does not already.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startMockCanvas, COOKIE } from './mock-canvas.js';
import { openDb } from '../src/db.js';
import { runSync, setCookie } from '../src/sync.js';
import { mountMcp, tokenMatches, bearerFrom } from '../src/mcp.js';
import { canvasToolDefs } from '../src/tools.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgpt-m-')), 'test.db');
const quiet = () => {};
const TOKEN = 'test-token-long-enough-to-be-accepted';

/** A populated database behind a live /mcp endpoint. */
async function serve({ token = TOKEN } = {}) {
  const mock = await startMockCanvas({ subentryCounts: { 12: 1 }, threadsByTopic: { 12: [
    { id: 700, user_id: 5, message: '<p>a reply about rubrics</p>', created_at: '2026-09-01T10:00:00Z' },
  ] }, participantsByTopic: { 12: [{ id: 5, display_name: 'Ada' }] } });
  const db = openDb(tmpDb());
  setCookie(db, COOKIE);
  process.env.CANVAS_HOST = mock.url;
  await runSync(db, { log: quiet });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const mounted = mountMcp(app, db, { token, log: quiet });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    db, url, mounted,
    close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock.close(); },
  };
}

async function connect(url, token = TOKEN) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

const post = (url, headers, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
});
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

// ---- credential comparison ------------------------------------------------

test('token comparison rejects prefixes, suffixes and the empty string', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('ab', 'abc'), false, 'a prefix is not a match');
  assert.equal(tokenMatches('abcd', 'abc'), false, 'a superstring is not a match');
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches('abc', ''), false, 'an unset expected token never matches');
  assert.equal(tokenMatches(undefined, 'abc'), false);
  assert.equal(tokenMatches('abc', undefined), false);
});

test('bearer parsing accepts RFC whitespace but not another scheme', () => {
  assert.equal(bearerFrom('Bearer abc'), 'abc');
  assert.equal(bearerFrom('bearer abc'), 'abc', 'scheme is case-insensitive');
  assert.equal(bearerFrom('Bearer   abc  '), 'abc', 'padding around the credential is not part of it');
  assert.equal(bearerFrom('Basic abc'), null);
  assert.equal(bearerFrom(''), null);
  assert.equal(bearerFrom(undefined), null);
});

// ---- fail closed ----------------------------------------------------------

test('the endpoint is not mounted at all without a token', async () => {
  const s = await serve({ token: '' });
  assert.equal(s.mounted, false, 'mountMcp reports it did nothing');
  const res = await post(s.url, {}, LIST);
  assert.equal(res.status, 404, 'there is no /mcp route to reach');
  await s.close();
});

test('a token too short to be a credential is refused', async () => {
  const s = await serve({ token: 'short' });
  assert.equal(s.mounted, false);
  await s.close();
});

test('requests without a valid bearer are rejected', async () => {
  const s = await serve();
  assert.equal((await post(s.url, {}, LIST)).status, 401, 'no header');
  assert.equal((await post(s.url, { Authorization: 'Bearer nope-nope-nope-nope-nope' }, LIST)).status, 401, 'wrong token');
  assert.equal((await post(s.url, { Authorization: `Basic ${TOKEN}` }, LIST)).status, 401, 'wrong scheme');

  const res = await post(s.url, {}, LIST);
  assert.match(res.headers.get('www-authenticate') || '', /Bearer/, 'tells the client how to authenticate');
  const body = await res.json();
  assert.equal(body.jsonrpc, '2.0', 'and answers in JSON-RPC, not html');
  await s.close();
});

test('a rejected request leaks nothing about the expected token', async () => {
  const s = await serve();
  const body = await (await post(s.url, { Authorization: 'Bearer wrong-wrong-wrong-wrong' }, LIST)).text();
  assert.ok(!body.includes(TOKEN), 'the real token never appears in an error');
  assert.ok(!/token/i.test(body) || /Unauthorized/.test(body), 'no hint about length or shape');
  await s.close();
});

// ---- the tool surface -----------------------------------------------------

test('the connector exposes exactly the tools the local agent has, all read-only', async () => {
  const s = await serve();
  const client = await connect(s.url);

  const { tools } = await client.listTools();
  const expected = canvasToolDefs(s.db).map((t) => t.name).sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), expected, 'no extra surface over MCP');
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'every tool declares itself read-only');
  assert.ok(tools.every((t) => t.description?.length > 20), 'each carries a usable description');

  await client.close();
  await s.close();
});

test('tools return real data over the wire, including discussion replies', async () => {
  const s = await serve();
  const client = await connect(s.url);

  const courses = await client.callTool({ name: 'list_courses', arguments: {} });
  const parsed = JSON.parse(courses.content[0].text);
  assert.ok(parsed.length >= 1, 'courses come back');
  assert.ok(parsed[0].id && parsed[0].name, 'with usable fields');

  const hit = await client.callTool({ name: 'search', arguments: { query: 'rubrics', kind: 'reply', limit: 5 } });
  assert.match(hit.content[0].text, /Ada/, 'a reply is searchable and attributed through the connector');

  await client.close();
  await s.close();
});

test('a bad argument is an answer, not a crash', async () => {
  const s = await serve();
  const client = await connect(s.url);
  const r = await client.callTool({ name: 'get_course', arguments: { course: 'no-such-course-anywhere' } });
  assert.match(r.content[0].text, /No course matching/);
  // The connection is still usable afterwards.
  assert.ok((await client.listTools()).tools.length > 0, 'server survived');
  await client.close();
  await s.close();
});

test('an unknown tool is refused', async () => {
  const s = await serve();
  const client = await connect(s.url);
  // MCP reports this as an error *result*, not a transport rejection, so a
  // caller that ignores isError must still get nothing executable back.
  const r = await client.callTool({ name: 'delete_everything', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not found/i);
  assert.ok((await client.listTools()).tools.length > 0, 'the connection survives it');
  await client.close();
  await s.close();
});

test('GET and DELETE are answered rather than left hanging', async () => {
  const s = await serve();
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(s.url, { method, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json, text/event-stream' } });
    assert.equal(res.status, 405, `${method} is answered`);
    assert.equal((await res.json()).jsonrpc, '2.0');
  }
  await s.close();
});

test('repeated connections do not accumulate handles', async () => {
  const s = await serve();
  for (let i = 0; i < 5; i++) {
    const c = await connect(s.url);
    await c.callTool({ name: 'list_courses', arguments: {} });
    await c.close();
  }
  // If servers or transports leaked per request this is where it would show as
  // a growing listener count on the process.
  const c = await connect(s.url);
  assert.ok((await c.listTools()).tools.length > 0, 'still serving after repeated churn');
  await c.close();
  await s.close();
});

test('the token may ride in the path for clients that cannot send headers', async () => {
  const s = await serve();
  const base = s.url.replace(/\/mcp$/, '');

  // Right token in the path authenticates.
  const ok = await post(`${base}/mcp/${TOKEN}`, {}, LIST);
  assert.equal(ok.status, 200);

  // Wrong token in the path does not, and neither does a bare path.
  assert.equal((await post(`${base}/mcp/not-the-token-not-the-token`, {}, LIST)).status, 401);
  assert.equal((await post(`${base}/mcp`, {}, LIST)).status, 401);

  // And it works end to end through a real client.
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)));
  assert.ok((await client.listTools()).tools.length === 7);
  await client.close();
  await s.close();
});
