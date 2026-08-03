// ============================================================
// MCP integration: minimal streamable-HTTP JSON-RPC client plus a
// server manager that exposes discovered tools to backends through
// the toolProvider interface (listDeclarations / callTool).
// Tool names are namespaced "server__tool" to avoid collisions.
// ============================================================
import {
  mcpBtn, mcpBadge, mcpModal, mcpModalClose, mcpModalDone,
  mcpConfigInput, mcpConnectBtn, mcpServerList
} from './dom.js';
import { toast } from './ui.js';
import { escapeHtml } from './text.js';

const CONFIG_KEY = 'combsllm.mcpConfig';
const MAX_RESULT_CHARS = 4000;

// ---- Minimal streamable-HTTP MCP client ----

class McpHttpClient {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this.nextId = 1;
    this.tools = [];
  }

  parseSse(text) {
    let last = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          const msg = JSON.parse(line.slice(5).trim());
          if (msg && typeof msg === 'object') last = msg;
        } catch { /* not a JSON data line */ }
      }
    }
    return last;
  }

  async rpc(method, params, { notification = false, _retried = false } = {}) {
    const body = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    // Session expired server-side (idle timeout etc.): per the MCP spec the
    // client must discard it and re-initialize, then retry the request once.
    if (res.status === 404 && this.sessionId && !_retried) {
      this.sessionId = null;
      await this.connect();
      return this.rpc(method, params, { notification, _retried: true });
    }

    if (notification || res.status === 202) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from MCP server`);

    const ct = res.headers.get('content-type') || '';
    const payload = ct.includes('text/event-stream') ? this.parseSse(await res.text()) : await res.json();
    if (!payload) throw new Error('Empty MCP response');
    if (payload.error) throw new Error(payload.error.message || 'MCP RPC error');
    return payload.result;
  }

  async connect() {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'combsllm', version: '1.0' }
    });
    await this.rpc('notifications/initialized', {}, { notification: true });
    const result = await this.rpc('tools/list', {});
    this.tools = result?.tools || [];
    return this.tools;
  }

  async callTool(name, args) {
    return this.rpc('tools/call', { name, arguments: args });
  }
}

// ---- Server manager (the toolProvider exposed to backends) ----

const servers = new Map(); // name -> { url, client, tools }
const syntheticTools = new Map(); // name -> { fn, description }
const changeListeners = new Set();

function notifyChange() {
  updateBadge();
  renderServerList();
  for (const cb of changeListeners) cb();
}

export function onServersChanged(cb) {
  changeListeners.add(cb);
}

export function getServers() {
  return [...servers.entries()].map(([name, s]) => ({
    name, url: s.url, tools: s.tools
  }));
}

function updateBadge() {
  const count = servers.size;
  mcpBadge.textContent = String(count);
  mcpBadge.classList.toggle('hidden', count === 0);
}

async function addServer(name, url) {
  if (servers.has(name)) await removeServer(name);
  const client = new McpHttpClient(url);
  const tools = await client.connect();
  servers.set(name, { url, client, tools });
  notifyChange();
  return tools;
}

async function removeServer(name) {
  servers.delete(name);
  notifyChange();
}

// LiteRT-LM tool declarations for all connected servers, in the wrapped
// FunctionTool format the model's chat template expects ({type, function}).
export async function listDeclarations() {
  const declarations = [];
  for (const [serverName, s] of servers) {
    for (const tool of s.tools) {
      // Screenshot handling is unified through the synthetic tool below.
      if (/screenshot/i.test(tool.name)) continue;
      // The wait tool is rarely used correctly by small models (missing ms arg).
      if (/^wait$/i.test(tool.name)) continue;
      // get_source encourages console-style scraping instead of visual browsing.
      if (/get_source/i.test(tool.name)) continue;
      declarations.push({
        type: 'function',
        function: {
          name: `${serverName}__${tool.name}`,
          description: `[${serverName}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema?.type === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} }
        }
      });
    }
  }
  for (const [name, t] of syntheticTools) {
    declarations.push({
      type: 'function',
      function: {
        name: `synthetic__${name}`,
        description: `[built-in] ${t.description}`,
        parameters: { type: 'object', properties: {} }
      }
    });
  }
  return declarations;
}

function normalizeResult(result) {
  if (!result) return '(empty result)';
  const parts = [];
  if (Array.isArray(result.content)) {
    for (const c of result.content) {
      parts.push(c.type === 'text' ? c.text : JSON.stringify(c));
    }
  }
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  let text = parts.filter(Boolean).join('\n') || JSON.stringify(result);
  if (result.isError) text = `Error: ${text}`;
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : text;
}

function availableToolNames() {
  const names = [];
  for (const [serverName, s] of servers) {
    for (const t of s.tools) names.push(`${serverName}__${t.name}`);
  }
  for (const name of syntheticTools.keys()) names.push(`synthetic__${name}`);
  return names;
}

export async function callTool(fullName, args) {
  const sep = fullName.indexOf('__');
  const serverName = sep === -1 ? fullName : fullName.slice(0, sep);
  const toolName = sep === -1 ? fullName : fullName.slice(sep + 2);
  const known = availableToolNames().join(', ') || '(none connected)';

  if (serverName === 'synthetic') {
    const tool = syntheticTools.get(toolName);
    if (!tool) throw new Error(`Unknown tool "${fullName}". Available tools: ${known}`);
    const result = await tool.fn(args || {});
    return normalizeResult(result);
  }

  const entry = servers.get(serverName);
  if (!entry || !entry.tools.some(t => t.name === toolName)) {
    throw new Error(`Unknown tool "${fullName}". Available tools: ${known}`);
  }
  const result = await entry.client.callTool(toolName, args || {});
  return normalizeResult(result);
}

export const mcpManager = { listDeclarations, callTool };

// Find the first screenshot-like tool from any connected server, call it,
// and return the resulting image as a data URL. Returns null if no such tool
// exists or the call fails.
function extractImage(result) {
  if (!result) return null;
  if (Array.isArray(result.content)) {
    for (const c of result.content) {
      if (c.type === 'image' && c.data) return c;
    }
  }
  if (result.structuredContent && result.structuredContent.type === 'image' && result.structuredContent.data) {
    return result.structuredContent;
  }
  return null;
}

export async function captureScreenshot() {
  for (const [serverName, s] of servers) {
    const tool = s.tools.find(t => /screenshot/i.test(t.name));
    if (!tool) continue;
    try {
      const result = await s.client.callTool(tool.name, {});
      const img = extractImage(result);
      if (img && img.data) {
        const mime = img.mimeType || 'image/png';
        return `data:${mime};base64,${img.data}`;
      }
    } catch {
      // try next server
    }
  }
  return null;
}

// Register a built-in screenshot tool that the orchestrator can expose to the
// agents. The tool result is just a short confirmation; the actual image is
// pushed onto the agent bus by the orchestrator.
function registerSyntheticTool(name, description, fn) {
  syntheticTools.set(name, { description, fn });
}

registerSyntheticTool('capture_screenshot', 'Capture a screenshot of the current browser page and report it as an image.', async () => {
  const hasScreenshotTool = [...servers.values()].some(s => s.tools.some(t => /screenshot/i.test(t.name)));
  if (!hasScreenshotTool) {
    return { content: [{ type: 'text', text: 'Error: no browser screenshot tool is connected.' }], isError: true };
  }
  return { content: [{ type: 'text', text: 'Screenshot captured.' }] };
});

// ---- Modal UI ----

const DEFAULT_CONFIG = JSON.stringify({
  mcpServers: {
    browserAutomation: { url: 'http://localhost:6182/sse' }
  }
}, null, 2);

function renderServerList() {
  if (!mcpServerList) return;
  mcpServerList.innerHTML = '';
  if (!servers.size) {
    mcpServerList.innerHTML = '<div class="mcp-empty">No servers connected.</div>';
    return;
  }
  for (const [name, s] of servers) {
    const row = document.createElement('div');
    row.className = 'mcp-server';
    row.innerHTML = `
      <div class="mcp-server-head">
        <span class="mcp-server-dot"></span>
        <div class="-server-info">
          <div class="mcp-server-name">${escapeHtml(name)}</div>
          <div class="mcp-server-url">${escapeHtml(s.url)}</div>
        </div>
        <button type="button" class="mcp-server-remove btn btn-ghost btn-sm">Disconnect</button>
      </div>
      <details class="mcp-server-tools">
        <summary>${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}</summary>
        <ul>${s.tools.map(t => `<li><code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.description || '')}</li>`).join('')}</ul>
      </details>`;
    row.querySelector('.mcp-server-remove').addEventListener('click', async () => {
      await removeServer(name);
      toast(`Disconnected from ${name}.`, 'info', 2500);
    });
    mcpServerList.appendChild(row);
  }
}

async function connectFromConfig() {
  let cfg;
  try {
    cfg = JSON.parse(mcpConfigInput.value.trim());
  } catch (e) {
    toast(`Invalid JSON: ${e.message}`, 'error', 5000);
    return;
  }
  const entries = Object.entries(cfg.mcpServers || {});
  if (!entries.length) {
    toast('No "mcpServers" entries in the config.', 'warning', 3500);
    return;
  }
  localStorage.setItem(CONFIG_KEY, mcpConfigInput.value.trim());
  for (const [name, serverCfg] of entries) {
    if (!serverCfg.url) {
      toast(`Server "${name}" is missing a url.`, 'error', 4000);
      continue;
    }
    try {
      const tools = await addServer(name, serverCfg.url);
      toast(`Connected to ${name} — ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`, 'success', 3500);
    } catch (e) {
      toast(`Failed to connect to ${name}: ${e.message}. Check the server is running and sends CORS headers.`, 'error', 6000);
    }
  }
}

function openModal() {
  renderServerList();
  mcpModal.classList.remove('hidden');
}

export function closeMcpModal() {
  mcpModal.classList.add('hidden');
}

export async function initMcp() {
  mcpConfigInput.value = localStorage.getItem(CONFIG_KEY) || DEFAULT_CONFIG;
  mcpBtn.addEventListener('click', openModal);
  mcpModalClose.addEventListener('click', closeMcpModal);
  mcpModalDone.addEventListener('click', closeMcpModal);
  mcpConnectBtn.addEventListener('click', connectFromConfig);
  mcpModal.addEventListener('click', (e) => {
    if (e.target === mcpModal) closeMcpModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !mcpModal.classList.contains('hidden')) closeMcpModal();
  });

  // Best-effort reconnect of the persisted config on startup.
  if (localStorage.getItem(CONFIG_KEY)) {
    try {
      const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY));
      for (const [name, serverCfg] of Object.entries(cfg.mcpServers || {})) {
        if (serverCfg.url) {
          try { await addServer(name, serverCfg.url); } catch { /* server offline; user can retry from the modal */ }
        }
      }
    } catch { /* corrupted config; ignore */ }
  }
  updateBadge();
}
