#!/usr/bin/env node
// ============================================================
// MCP CORS proxy — lets the browser client reach MCP servers that
// don't send CORS headers (e.g. @playwright/mcp).
//
//   node mcp-proxy.mjs --target http://localhost:6784/mcp --port 8931
//
// Then point the app's MCP config at http://localhost:8931/mcp.
//
// Notes:
// - The Origin header is intentionally NOT forwarded: MCP servers
//   validate it for DNS-rebinding protection, and a proxy hop means
//   the request is no longer browser-originated.
// - Responses are buffered, so this proxies request/response traffic
//   (our client) but not long-lived GET SSE streams.
// ============================================================
import http from 'node:http';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const TARGET = arg('target', 'http://localhost:6181/sse');
const PORT = parseInt(arg('port', '8182'), 10);

const server = http.createServer((req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const headers = {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Accept': req.headers['accept'] || 'application/json, text/event-stream'
      };
      if (req.headers['mcp-session-id']) headers['Mcp-Session-Id'] = req.headers['mcp-session-id'];
      if (req.headers['mcp-protocol-version']) headers['MCP-Protocol-Version'] = req.headers['mcp-protocol-version'];

      const upstream = await fetch(TARGET, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
      });

      const outHeaders = {
        ...corsHeaders,
        'Content-Type': upstream.headers.get('content-type') || 'application/json'
      };
      const sid = upstream.headers.get('mcp-session-id');
      if (sid) outHeaders['Mcp-Session-Id'] = sid;

      res.writeHead(upstream.status, outHeaders);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end(`MCP proxy error: ${e.message}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`MCP CORS proxy → ${TARGET}`);
  console.log(`Listening on http://localhost:${PORT}/sse`);
});
