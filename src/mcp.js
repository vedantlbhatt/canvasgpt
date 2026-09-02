/**
 * Remote MCP endpoint, so Claude can talk to this mirror as a custom connector.
 *
 * Three deliberate choices:
 *
 *   1. Stateless. Every request builds a fresh server and transport and tears
 *      them down on close. There is no session table to leak or expire, which
 *      matters because a connector reconnects on its own schedule.
 *   2. Bearer auth, failing closed. Without MCP_TOKEN the endpoint is not
 *      mounted at all — an unauthenticated Canvas mirror on a public URL would
 *      hand a stranger the user's coursework.
 *   3. The same seven read-only tools the local agent gets, from one shared
 *      definition list. A connector that could do more than the chat UI would
 *      be a second, unaudited surface.
 */
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { canvasToolDefs, CANVAS_SERVER_INFO } from './tools.js';

/** Constant-time compare that tolerates length mismatch without leaking it. */
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Pull a bearer token out of an Authorization header. */
export function bearerFrom(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return m ? m[1].trim() : null;
}

/** Build a fresh MCP server exposing the read-only Canvas tools. */
export function buildMcpServer(db) {
  const server = new McpServer(
    { name: CANVAS_SERVER_INFO.name, version: CANVAS_SERVER_INFO.version },
    { instructions: CANVAS_SERVER_INFO.instructions, capabilities: { tools: {} } },
  );
  for (const def of canvasToolDefs(db)) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        // Advertised so a client knows this connector cannot change anything.
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (args) => def.handler(args ?? {}, {}),
    );
  }
  return server;
}

/**
 * Mount POST/GET/DELETE /mcp on an Express app.
 * Returns false (and mounts nothing) when no token is configured.
 */
export function mountMcp(app, db, { token = process.env.MCP_TOKEN, log = console.log } = {}) {
  if (!token) {
    log('mcp: MCP_TOKEN not set — /mcp is disabled. Set one to enable the connector.');
    return false;
  }
  if (token.length < 24) {
    log('mcp: MCP_TOKEN is too short to be a credential — /mcp is disabled.');
    return false;
  }

  // Connector UIs that accept only a URL (claude.ai's among them) cannot send
  // an Authorization header, so the token may ride in the path instead. That
  // puts a secret in a URL — it lands in browser history, proxy and server
  // logs — so it is a fallback for those clients, not the preferred route.
  const authed = (req, res, next) => {
    const presented = bearerFrom(req.headers.authorization) ?? req.params?.token ?? null;
    if (!tokenMatches(presented, token)) {
      // 401 + WWW-Authenticate is what an MCP client expects when it needs to
      // (re)present a credential.
      res.setHeader('WWW-Authenticate', 'Bearer realm="canvasgpt"');
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
    }
    return next();
  };

  const handle = async (req, res) => {
    const server = buildMcpServer(db);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Tear both down when the client goes away, or a long-lived connector
    // leaks a server per request.
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`mcp: request failed — ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  };

  app.post('/mcp', authed, handle);
  app.post('/mcp/:token', authed, handle);
  // A stateless server has no stream to resume and no session to delete; say so
  // rather than leaving the client waiting.
  const noSession = (_req, res) => res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this server is stateless.' },
    id: null,
  });
  app.get('/mcp', authed, noSession);
  app.delete('/mcp', authed, noSession);
  app.get('/mcp/:token', authed, noSession);
  app.delete('/mcp/:token', authed, noSession);

  log('mcp: /mcp enabled (bearer header or /mcp/<token>, 7 read-only tools)');
  return true;
}
