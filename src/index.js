// src/index.js
const { createMcpAgent } = require('@cloudflare/playwright-mcp');

// BROWSER is injected by the MCP package; no special binding needed in Node
const PlaywrightMCP = createMcpAgent();

// Create a tiny HTTP server using the built-in Node API
const http = require('http');
const url  = require('url');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname === '/sse') {
    // Let MCP handle the WebSocket upgrade and streaming
    const mcpHandler = PlaywrightMCP.mount('/sse');
    return mcpHandler.fetch(req, { });
  }
  res.writeHead(404);
  res.end('Not found');
});

const port = process.env.PORT || 8787;
server.listen(port, () => {
  console.log(`MCP server listening on http://0.0.0.0:${port}/sse`);
});
