// ============================================================
// Agent orchestrator: two LLM sessions (controller + worker) talking
// over a polled message bus. Runtime-agnostic:
//   - litert: two native conversations on the shared engine, worker
//     gets MCP tools through the conversation preface.
//   - tasks (tasks-genai): stateless per-turn prompts rebuilt from
//     per-agent history; tools are described in the worker prompt and
//     invoked via <tool_call>{...}</tool_call> markers (ReAct loop).
// All turns pass through a single engine lock — one generation at a
// time across both agents, regardless of poll timers.
// Runs persist to the agent-runs store — separate from chat history.
// ============================================================
import {
  agentsBtn, agentsPage, agentsTask, agentsStart, agentsStop,
  agentsControllerPrompt, agentsWorkerPrompt, agentsControllerInterval,
  agentsWorkerInterval, agentsMaxMinutes, agentsStopPhrase,
  agentsStatusText, agentsElapsed, agentsStats, agentsExport, agentsValidated,
  agentsBadge, agentsSettings, agentsTurnCap, toggleConsoleBtn,
  agentsControllerLog, agentsWorkerLog, agentsFinal,
  consolePanel, chatScroll, composer, headerTitle, newChatBtnLabel,
  spectatorsEnabled,
  specALog, specACount, specANext, specADot,
  specScoutLog, specScoutCount, specScoutNext, specScoutDot,
  specBLog, specBCount, specBNext, specBDot
} from './dom.js';
import { state } from './state.js';
import { toast, showConfirmModal, hideConfirmModal } from './ui.js';
import { escapeHtml, deriveTitle } from './text.js';
import { mcpManager, captureScreenshot } from './mcp.js';
import { buildPrompt } from './prompts.js';
import { idbPutAgentRun, idbGetAgentRuns, idbDeleteAgentRun } from './store.js';
import { getModelName } from './config.js';
import { dataUrlToBase64 } from './image.js';

const PROMPT_KEYS = {
  controller: 'combsllm.agents.controllerPrompt',
  worker: 'combsllm.agents.workerPrompt',
  controllerInterval: 'combsllm.agents.controllerInterval',
  workerInterval: 'combsllm.agents.workerInterval',
  maxMinutes: 'combsllm.agents.maxMinutes',
  stopPhrase: 'combsllm.agents.stopPhrase'
};

const MAX_TOOL_ROUNDS = 1;
// Default hard cap on one controller/worker generation (configurable in the
// run settings): the stream is cancelled at the deadline and the turn
// continues with whatever partial text arrived.
const DEFAULT_STREAM_TIME_LIMIT_S = 40;
let runAgentTurn = null; // lazy-loaded only when LiteRT-LM is used
const DEBUG_AGENTS = true;

function summarizeContent(content) {
  if (Array.isArray(content)) {
    return content.map(p => {
      if (p.type === 'image') return { type: 'image', alt: p.alt || '(image)', size: p.dataUrl?.length || 0 };
      if (p.type === 'text') return { type: 'text', text: p.text?.slice(0, 200) + (p.text?.length > 200 ? '…' : '') };
      return p;
    });
  }
  if (typeof content === 'string' && content.length > 300) return content.slice(0, 300) + '…';
  return content;
}

function logAgent(label, data) {
  if (!DEBUG_AGENTS) return;
  let body;
  if (typeof data === 'string') body = data;
  else try { body = JSON.stringify(data, null, 2); } catch { body = String(data); }
  console.log(`[AGENT ${new Date().toISOString()}] ${label}\n${body}`);
}

function logPrompt(label, prompt) {
  if (!DEBUG_AGENTS) return;
  let text;
  if (typeof prompt === 'string') text = prompt;
  else if (Array.isArray(prompt)) {
    text = prompt.map(p => {
      if (typeof p === 'string') return p;
      if (p.type === 'text') return p.text || '';
      if (p.type === 'image') return p.alt || '(image)';
      return String(p);
    }).join('');
  } else text = String(prompt);
  console.log(`[PROMPT ${label}]\n${text}`);
}

export const DEFAULT_CONTROLLER_PROMPT = `You are the CONTROLLER. A WORKER reports to you; its messages start with [worker]. Your replies go to the worker.

User's task: {{task}}

Rules:
- Give the worker ONE short instruction at a time using the exact tool names below.
- The worker executes tools; you do not. Never output <tool_call>.
- Only say {{stopPhrase}} after the worker has reported verified results from real tool calls and you are satisfied. Then follow it with the final answer.
- Do NOT say {{stopPhrase}} before the worker has reported verified results.
- If the worker says it has no working tools or only reports errors, tell it the exact tool name to call.
- Read the worker's [tool] result lines — never repeat an instruction whose tool already succeeded; move to the next step. If unsure what is on screen, ask for a screenshot.
- NEVER write lines starting with [worker] or [tool] yourself — those are the worker's reports. Inventing them is fabrication; only real worker messages count as evidence.

Search workflow (preferred):
1. Navigate to https://duckduckgo.com.
2. Type the search query into the search box.
3. Press Enter.
4. Take a screenshot (synthetic__capture_screenshot) to see results.
5. Scroll if needed, move the mouse, click the best result.
6. Take screenshots to verify the answer.
- Do NOT tell the worker to use get_source or the browser console.
- Use only: navigate, type, press_key, move_mouse, click, scroll, capture_screenshot.

Tools:
{{tools}}`;

export const DEFAULT_WORKER_PROMPT = `You are the WORKER, a browsing assistant. The CONTROLLER's directions start with [controller].

User's task: {{task}}

Rules:
- Follow the controller's ONE instruction by calling exactly one tool from the list below.
- To call a tool, output ONLY a line like: <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>
- After the tool runs you will receive its result. Report what it returned, or the exact error text.
- Do not narrate actions. Do not make up results.
- Stop only when the controller says {{stopPhrase}}.

Browsing process:
- Search on DuckDuckGo, press Enter, take screenshots to see results, scroll, move the mouse, click links.
- Do not use get_source or the browser console.
- Take a screenshot whenever the controller asks you to verify what is on screen.`;

// ============================================================
// Agent sessions — one interface, two runtime implementations
// ============================================================

// litert: native conversation with tool channel.
class LitertAgentSession {
  constructor(conversation, withTools, timeLimitMs = 0) {
    this.conversation = conversation;
    this.withTools = withTools;
    this.timeLimitMs = timeLimitMs;
    this.lastTurnTimedOut = false;
  }

  normalizePayload(payload) {
    if (!Array.isArray(payload)) return payload;
    return payload.map(p => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      if (p.type === 'image' && p.dataUrl) return { type: 'image', blob: dataUrlToBase64(p.dataUrl) };
      return p;
    });
  }

  async turn(payload, { onText, onToolCall, onBeforeToolCall, onAfterToolCall }) {
    const normalized = this.normalizePayload(payload);
    logPrompt('litert payload', payload);
    logAgent('LITERT SESSION TURN', { withTools: this.withTools, timeLimitMs: this.timeLimitMs });
    this.lastTurnTimedOut = false;
    return runAgentTurn(this.conversation, normalized, {
      toolProvider: this.withTools ? mcpManager : null,
      onText,
      onToolCall,
      onBeforeToolCall,
      onAfterToolCall,
      maxToolRounds: this.withTools ? 1 : MAX_TOOL_ROUNDS,
      timeLimitMs: this.timeLimitMs,
      onTimeout: () => { this.lastTurnTimedOut = true; }
    });
  }
  async dispose() {
    try { await this.conversation.delete(); } catch { /* already gone */ }
  }
}

// tasks-genai: stateless; per-agent history rebuilt into a prompt each
// turn. Tools are prompt-based: the model emits <tool_call>{...}</tool_call>
// and receives [tool_result] messages back.
const MAX_TOOL_RESULT_CHARS = 4000;

function tryParseToolCall(raw, toolNames) {
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Small models often drop quotes around keys: {"arguments":{url":"..."}}.
    try {
      const repaired = raw.replace(/([{,]\s*)([A-Za-z_$][\w$]*)"?\s*:/g, '$1"$2":');
      obj = JSON.parse(repaired);
    } catch { /* unrecoverable — ignore */ }
  }
  if (obj && typeof obj.name === 'string' && toolNames.has(obj.name)) {
    return { name: obj.name, arguments: obj.arguments || obj.args || obj.parameters || {} };
  }
  return null;
}

class TasksAgentSession {
  constructor(backend, systemPrompt, withTools, declarations = [], timeLimitMs = 0) {
    this.backend = backend;
    this.withTools = withTools;
    this.timeLimitMs = timeLimitMs;
    this.lastTurnTimedOut = false;
    this.history = [{ role: 'system', content: systemPrompt }];
    this.declarations = declarations;
    this.toolNames = new Set(declarations.map(d => d.function.name));
  }

  parseToolCalls(text) {
    const calls = [];
    const seen = new Set();
    const add = (raw) => {
      const call = tryParseToolCall(raw, this.toolNames);
      if (!call) return;
      const key = JSON.stringify(call);
      if (seen.has(key)) return;
      seen.add(key);
      calls.push(call);
    };

    // 1. Explicit <tool_call>...</tool_call> markers. Capture everything
    // between the tags, then slice out the outermost braces — a non-greedy
    // brace match stops at the inner "arguments" close and loses the call.
    const markerRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let m;
    while ((m = markerRe.exec(text))) {
      const inner = m[1].trim();
      const start = inner.indexOf('{');
      const end = inner.lastIndexOf('}');
      if (start !== -1 && end > start) add(inner.slice(start, end + 1));
    }

    // 2. JSON code blocks.
    const codeRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    while ((m = codeRe.exec(text))) add(m[1]);

    // 3. Standalone JSON lines that mention a known tool name.
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) add(trimmed);
    }

    return calls;
  }

  trimHistory(max = 8) {
    if (this.history.length <= max) return;
    const keep = [this.history[0]]; // system prompt
    if (this.history.length > 1 && this.history[1].role === 'user') keep.push(this.history[1]); // original task
    const tail = this.history.slice(-(max - keep.length));
    this.history = keep.concat(tail);
  }

  async turn(payload, { onText, onToolCall, onBeforeToolCall, onAfterToolCall }) {
    // Reset to system prompt + current payload so small models do not drown in
    // previous turn templates and failed attempts.
    this.history = [this.history[0], { role: 'user', content: payload }];
    logAgent('TASKS SESSION TURN START', { withTools: this.withTools, historyLength: this.history.length });
    let fullText = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const t0 = performance.now();
      const prompt = await buildPrompt(this.history, false, this.backend.promptFormat);
      logPrompt(`tasks round ${round}`, prompt);
      let text = '';
      let roundTimedOut = false;
      const genPromise = this.backend.llm.generateResponse(prompt, (partial) => {
        if (partial && !roundTimedOut) { text += partial; onText(partial); }
      });
      let full;
      if (this.timeLimitMs > 0) {
        // Hard stream cap: cancel decoding at the deadline and continue the
        // turn with the partial text. The late result is swallowed and the
        // cancel signal reset so the next turn starts clean.
        full = await Promise.race([
          genPromise,
          new Promise(resolve => setTimeout(() => {
            roundTimedOut = true;
            this.lastTurnTimedOut = true;
            try { this.backend.llm.cancelProcessing(); } catch { /* best effort */ }
            resolve(undefined);
          }, this.timeLimitMs))
        ]);
        if (roundTimedOut) {
          genPromise.then(
            () => { try { this.backend.llm.clearCancelSignals(); } catch { /* best effort */ } },
            () => { try { this.backend.llm.clearCancelSignals(); } catch { /* best effort */ } }
          );
        }
      } else {
        full = await genPromise;
      }
      text = text || full || '';
      this.history.push({ role: 'assistant', content: text });
      fullText += text;
      logAgent('TASKS GENERATION', { round, durationMs: Math.round(performance.now() - t0), rawText: text });

      if (!this.withTools) return fullText;
      const calls = this.parseToolCalls(text);
      logAgent('TASKS PARSED TOOL CALLS', { round, calls });
      if (!calls.length) return fullText;

      const results = [];
      for (const c of calls) {
        await onBeforeToolCall({ function: c });
        let resultText;
        try {
          resultText = await mcpManager.callTool(c.name, c.arguments || {});
        } catch (e) {
          resultText = `Error: ${e.message}`;
        }
        if (resultText && resultText.length > MAX_TOOL_RESULT_CHARS) {
          resultText = `${resultText.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`;
        }
        onToolCall({ function: c }, resultText);
        await onAfterToolCall({ function: c }, resultText);
        results.push(`[tool_result] ${c.name}: ${resultText}`);
      }
      this.history.push({ role: 'user', content: results.join('\n') });
      logAgent('TASKS TOOL RESULTS ADDED', { round, results: results.map(r => summarizeContent(r)) });
      fullText += '\n\n';
      onText('\n\n');
    }
    return fullText;
  }

  async dispose() { /* stateless — nothing to release */ }
}

// Build the worker's system prompt: base rules + tool discipline + the live
// tool catalog. tasks-genai additionally gets the explicit call syntax
// since it has no native tool channel.
function formatToolDoc(decl) {
  const fn = decl.function;
  const params = fn.parameters || {};
  const props = params.properties || {};
  const required = new Set(params.required || []);
  const args = Object.entries(props).map(([name, schema]) => {
    const req = required.has(name) ? 'required' : 'optional';
    const type = schema.type || 'any';
    return `${name} (${req}, ${type})`;
  }).join(', ') || 'none';
  return `- ${fn.name}: ${fn.description} | args: { ${args} }`;
}

function buildWorkerPrompt(config, declarations, kind, supportsVision) {
  const base = fillPrompt(config.workerPrompt, config);
  const toolDocs = declarations.length
    ? declarations.map(formatToolDoc).join('\n')
    : '(no tools connected)';
  // Prefer navigate as the example — a launch_browser example primes small
  // models to answer every instruction by re-launching the browser.
  const exampleDecl = declarations.find(d => /navigate/i.test(d.function.name))
    || declarations.find(d => /launch.*browser/i.test(d.function.name))
    || declarations[0];
  const exampleName = exampleDecl?.function.name || 'server__tool';
  const exampleArgs = /navigate/i.test(exampleName)
    ? '{"url":"https://duckduckgo.com"}'
    : (/launch.*browser/i.test(exampleName) ? '{}' : '{"arg":"value"}');
  const syntax = kind === 'tasks'
    ? `To call a tool, output ONLY a line like:\n<tool_call>{"name":"${exampleName}","arguments":${exampleArgs}}</tool_call>\nReplace the name and arguments with the real tool you need.`
    : 'Use the native tool channel bound to this session.';
  const screenshotLine = supportsVision
    ? '\n- When the controller asks for a screenshot, call synthetic__capture_screenshot.'
    : '';
  return `${base}\n\n${syntax}${screenshotLine}\n\nAvailable tools:\n${toolDocs}`;
}

// ============================================================
// Run state
// ============================================================
let running = false;
let engineBusy = false; // one generation at a time across both agents
let run = null;

function pushBus(from, content, meta = {}) {
  const entry = { from, content, meta, t: Date.now() };
  run.bus.push(entry);
  logAgent('BUS PUSH', { entry: { from, content: summarizeContent(content), meta, t: entry.t }, busLength: run.bus.length });
}

// Forwarded view of a bus entry for the receiving agent. Tool-call counts
// travel with worker messages so the controller can spot fabricated work.
function formatEntry(e) {
  if (Array.isArray(e.content)) {
    const alt = e.content.find(p => p.alt)?.alt || '📷 image';
    return `[${e.from}]: ${alt}`;
  }
  const note = e.meta?.toolCalls != null ? ` | tool calls: ${e.meta.toolCalls}` : '';
  return `[${e.from}${note}]: ${e.content}`;
}

const truncate = (t, n = 200) => (t.length > n ? `${t.slice(0, n)}…` : t);

// Payload sent into an agent's session: a rolling transcript of recent bus
// entries (so stateless agents can tell real progress from imagination), the
// new entries, plus a closing instruction that discourages parroting.
function formatPayload(entries, agentName, contextEntries = []) {
  const parts = [];
  let textBuf = '';
  const flushText = () => {
    if (textBuf) {
      parts.push({ type: 'text', text: textBuf.trimEnd() });
      textBuf = '';
    }
  };
  if (contextEntries.length) {
    textBuf += '(transcript so far)\n';
    for (const e of contextEntries) textBuf += `${formatEntry(e)}\n\n`;
    textBuf += '(latest messages — reply to these)\n\n';
  }
  for (const e of entries) {
    if (Array.isArray(e.content)) {
      flushText();
      for (const part of e.content) {
        if (part.type === 'image' && part.dataUrl) {
          parts.push({ type: 'image', dataUrl: part.dataUrl, alt: part.alt || '📷 image' });
        } else if (part.type === 'text') {
          textBuf += `${part.text}\n\n`;
        }
      }
      flushText();
    } else {
      textBuf += `${formatEntry(e)}\n\n`;
    }
  }
  flushText();
  parts.push({ type: 'text', text: `\n\n(Respond now as the ${agentName}. Do not repeat these messages back — produce new content only.)` });
  if (parts.length === 1) return parts[0].text;
  return parts;
}

// Recent bus entries visible to an agent, excluding the new ones it is about
// to answer. Bounded so small models are not drowned in history.
function contextFor(agent, newEntries, max = 8) {
  const visible = run.bus.filter(e => isVisibleTo(e, agent));
  return visible.slice(0, Math.max(0, visible.length - newEntries.length)).slice(-max);
}

// Small models often echo the injected payload verbatim before answering.
// Strip leading "[from ...]:" parrot prefixes; keep the content after them.
function stripEcho(text, entries) {
  let out = text.trimStart();
  const froms = new Set(entries.map(e => e.from));
  while (true) {
    const m = out.match(/^\[(\w+)([^\]]*)\]:\s*/);
    if (!m || !froms.has(m[1])) break;
    out = out.slice(m[0].length).trimStart();
  }
  return out;
}

function metaLog(el, text) {
  const div = document.createElement('div');
  div.className = 'agents-meta';
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function makeStreamTarget(el) {
  let span = null;
  return (chunk) => {
    if (!span) {
      const div = document.createElement('div');
      div.className = 'agents-msg';
      span = document.createElement('span');
      div.appendChild(span);
      el.appendChild(div);
    }
    span.textContent += chunk;
    el.scrollTop = el.scrollHeight;
  };
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderStats() {
  if (!run) return;
  const sp = run.stats.spectators || { a: 0, scout: 0, b: 0 };
  agentsStats.textContent = `turns C:${run.stats.controllerTurns} · W:${run.stats.workerTurns} · tools:${run.stats.toolCalls} · A:${sp.a} · S:${sp.scout} · B:${sp.b}`;
  agentsElapsed.textContent = fmtElapsed(Date.now() - run.startedAt);
  renderSpectatorChips();
}

function setStatus(text, cls = '') {
  agentsStatusText.textContent = text;
  agentsStatusText.className = 'agents-status-text ' + cls;
}

function generateStopPhrase() {
  const token = (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    : Math.random().toString(36).slice(2, 12)).toUpperCase();
  return `COMBS-${token}`;
}

function readConfig() {
  return {
    task: agentsTask.value.trim(),
    controllerPrompt: agentsControllerPrompt.value,
    workerPrompt: agentsWorkerPrompt.value,
    controllerInterval: Math.max(2, parseInt(agentsControllerInterval.value) || 30),
    workerInterval: Math.max(2, parseInt(agentsWorkerInterval.value) || 10),
    maxMinutes: Math.max(1, parseInt(agentsMaxMinutes.value) || 30),
    turnCapSeconds: Math.min(300, Math.max(5, parseInt(agentsTurnCap.value) || DEFAULT_STREAM_TIME_LIMIT_S)),
    stopPhrase: (agentsStopPhrase.value || generateStopPhrase()).trim()
  };
}

function fillPrompt(template, config) {
  return template
    .replaceAll('{{task}}', config.task)
    .replaceAll('{{stopPhrase}}', config.stopPhrase);
}

// Controller prompt: base rules + the live tool catalog so its directions
// reference real tools instead of hallucinated ones.
function buildControllerPrompt(config, declarations) {
  const toolDocs = declarations.length
    ? declarations.map(formatToolDoc).join('\n')
    : '(no tools connected — the worker can only talk; do not finish until you accept its answer may be unverified)';
  return fillPrompt(config.controllerPrompt, config).replaceAll('{{tools}}', toolDocs);
}

function isVisibleTo(entry, agent) {
  return entry.from !== agent && (!entry.meta?.forAgent || entry.meta.forAgent === agent);
}

function unseenEntries(agent) {
  const entries = run.bus.slice(run.seen[agent]).filter(e => isVisibleTo(e, agent));
  run.seen[agent] = run.bus.length;
  return entries;
}

// Pause/resume the poll timers around tool execution so no agent sneaks in
// while a tool is being invoked.
function pauseRuns() {
  if (!run) return;
  run.paused = true;
  setStatus('Running · paused for tool', 'running');
  logAgent('RUNS PAUSED', { turnInFlight: run.turnInFlight });
}

function resumeRuns() {
  if (!run || !run.paused) return;
  run.paused = false;
  logAgent('RUNS RESUMED', {});
  setStatus(`Running · ${run.sessions.runtimeLabel}`, 'running');
}

// Whether the mounted backend can actually see images we feed it.
function backendSupportsVision() {
  if (!state.backend) return false;
  if (state.backend.kind === 'litert') return !!state.backend.modalities?.vision;
  if (state.backend.kind === 'tasks') return !!state.backend.vision;
  return false;
}

// ============================================================
// Spectator agents — three context-free vision agents that watch the run:
//   - Critics A/B: screenshot the agent page on a random 1–2 min timer and
//     comment on how well the controller and worker are working. Display only.
//   - Scout: pulls the browser screenshot from the MCP server, describes it,
//     and pipes the description onto the bus so the controller and worker get
//     it as small context on their next turns.
// All spectators share the single engine lock — one generation at a time.
// ============================================================
const SPECTATOR_MIN_MS = 60_000;
const SPECTATOR_MAX_MS = 120_000;
const SPECTATOR_RETRY_MS = 25_000; // engine was busy — try again soon

const OBSERVER_A_PROMPT = `You are CRITIC A, an external performance critic watching a screenshot of a two-agent LLM orchestration console. A CONTROLLER plans and issues instructions; a WORKER executes browser tools and reports results. You receive no other context — only the image.

Read everything you can from the image: the logs, statuses, counters and elapsed time. Then comment in 2–4 short sentences on how well the controller and worker are working — are they making real progress, stuck, looping, or idle? Be specific about what you actually see.`;

const OBSERVER_B_PROMPT = `You are CRITIC B, an efficiency analyst watching a screenshot of a two-agent LLM orchestration console. A CONTROLLER plans and issues instructions; a WORKER executes browser tools and reports results. You receive no other context — only the image.

Read everything you can from the image. Then comment in 2–4 short sentences on their efficiency: wasted or repeated turns, vague instructions, unverified claims, and whether the tool-call count justifies the elapsed time. Be blunt and specific.`;

const SCOUT_PROMPT = `You are the SCOUT. You receive a fresh screenshot from a browser controlled by a pair of agents (a controller and a worker). Describe the image in 2–3 plain factual sentences: what page or screen is shown, its key content, and any obvious state (errors, popups, captchas, loading spinners). Your description is forwarded to the agents as context — no commentary, just what is visible.`;

const SPECTATORS = {
  a: {
    kind: 'page',
    prompt: OBSERVER_A_PROMPT,
    instruction: 'Here is the current console. Comment on how well the controller and worker are working.',
    log: () => specALog, count: () => specACount, next: () => specANext, dot: () => specADot
  },
  scout: {
    kind: 'mcp',
    prompt: SCOUT_PROMPT,
    instruction: 'Describe this screenshot.',
    log: () => specScoutLog, count: () => specScoutCount, next: () => specScoutNext, dot: () => specScoutDot
  },
  b: {
    kind: 'page',
    prompt: OBSERVER_B_PROMPT,
    instruction: 'Here is the current console. Comment on how efficiently the controller and worker are working.',
    log: () => specBLog, count: () => specBCount, next: () => specBNext, dot: () => specBDot
  }
};

let html2canvasPromise = null;
function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!html2canvasPromise) {
    html2canvasPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => { html2canvasPromise = null; reject(new Error('failed to load page-capture library')); };
      document.head.appendChild(s);
    });
  }
  return html2canvasPromise;
}

// Screenshot the agents page if it is showing, else the main page.
async function captureAgentPageImage() {
  const h2c = await loadHtml2Canvas();
  const pageInner = document.querySelector('.agents-page-inner');
  const target = (state.view === 'agents' && pageInner)
    ? pageInner
    : (document.getElementById('main') || document.body);
  const scale = Math.min(1, 1024 / Math.max(target.scrollWidth || target.offsetWidth || 1024, 1));
  const canvas = await h2c(target, {
    scale,
    logging: false,
    useCORS: true,
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff'
  });
  return canvas.toDataURL('image/jpeg', 0.85);
}

function setSpectatorDot(key, cls) {
  SPECTATORS[key].dot().className = 'spectator-dot' + (cls ? ' ' + cls : '');
}

// Fresh, context-free session per fire. litert conversations are one-shot
// (created and deleted around the turn); tasks sessions are stateless per
// turn anyway, so one instance per spectator is reused across the run.
async function makeSpectatorSession(key, prompt) {
  if (state.backend.kind === 'litert') {
    if (!runAgentTurn) {
      const mod = await import('./backends/litert.js');
      runAgentTurn = mod.runAgentTurn;
    }
    const conversation = await state.backend.engine.createConversation({
      preface: { messages: [{ role: 'system', content: prompt }] }
    });
    return { session: new LitertAgentSession(conversation, false), oneShot: true };
  }
  if (!run.spectatorSessions[key]) {
    run.spectatorSessions[key] = new TasksAgentSession(state.backend, prompt, false, []);
  }
  return { session: run.spectatorSessions[key], oneShot: false };
}

// Show the captured image right in the spectator's panel (click = full size).
function imageLog(el, dataUrl, alt) {
  const img = document.createElement('img');
  img.className = 'agents-thumb';
  img.src = dataUrl;
  img.alt = alt;
  img.loading = 'lazy';
  img.title = 'Click to open full size';
  img.addEventListener('click', () => window.open(dataUrl, '_blank'));
  el.appendChild(img);
  el.scrollTop = el.scrollHeight;
}

// One spectator fire. Returns true if a turn actually ran (false = skipped,
// caller reschedules a quick retry). instructionOverride is used for the
// final critic review at the end of a run.
async function spectatorTurn(key, instructionOverride = null) {
  const spec = SPECTATORS[key];
  if (!run || !running) return false;
  if (!spectatorsEnabled.checked && !run.pendingFinish) return false;
  if ((run.paused && !run.pendingFinish) || engineBusy) return false;
  if (!backendSupportsVision()) {
    metaLog(spec.log(), '⚠ enable the Vision toggle to activate spectators');
    return true; // no point retrying soon
  }
  engineBusy = true;
  setSpectatorDot(key, 'active');
  const t0 = performance.now();
  try {
    let dataUrl, alt;
    if (spec.kind === 'page') {
      dataUrl = await captureAgentPageImage();
      if (!dataUrl) throw new Error('page capture failed');
      alt = '🖥 agent page';
    } else {
      dataUrl = await captureScreenshot();
      if (!dataUrl) throw new Error('no MCP screenshot tool connected');
      alt = '📷 MCP screenshot';
    }
    if (!run) return true;
    metaLog(spec.log(), `⇐ ${alt}`);
    imageLog(spec.log(), dataUrl, alt);
    const { session, oneShot } = await makeSpectatorSession(key, spec.prompt);
    // The critics also get the scout's latest read of the worker's browser,
    // so their commentary can cross-check what the worker actually sees.
    let instruction = instructionOverride || spec.instruction;
    if (spec.kind === 'page' && run.lastScoutDescription && !instructionOverride) {
      instruction += `\n\nThe scout's latest description of the worker's browser: "${run.lastScoutDescription}"`;
    }
    const payload = [
      { type: 'image', dataUrl, alt },
      { type: 'text', text: instruction }
    ];
    logAgent(`SPECTATOR ${key.toUpperCase()} TURN START`, { kind: spec.kind });
    let text;
    try {
      text = await session.turn(payload, {
        onText: makeStreamTarget(spec.log()),
        onToolCall: () => {},
        onBeforeToolCall: () => {},
        onAfterToolCall: () => {}
      });
    } finally {
      if (oneShot) await session.dispose();
    }
    if (!run) return true;
    text = (text || '').trim() || '(no comment)';
    run.stats.spectators[key]++;
    // Persist the full turn (image + text) so the run export has everything.
    run.spectatorLog.push({ agent: key, t: Date.now(), kind: spec.kind, image: dataUrl, text });
    logAgent(`SPECTATOR ${key.toUpperCase()} TURN END`, { durationMs: Math.round(performance.now() - t0), text });
    if (spec.kind === 'mcp') {
      run.lastScoutDescription = truncate(text, 400);
      pushBus('scout', run.lastScoutDescription);
      metaLog(spec.log(), '⇒ piped to controller & worker');
    }
  } catch (e) {
    if (run) metaLog(spec.log(), `⚠ ${e.message}`);
    logAgent(`SPECTATOR ${key.toUpperCase()} ERROR`, { error: e.message });
  }
  if (run) setSpectatorDot(key, 'waiting');
  engineBusy = false;
  renderStats();
  return true;
}

function scheduleSpectator(key, delayMs) {
  if (!run) return;
  const delay = delayMs ?? (SPECTATOR_MIN_MS + Math.random() * (SPECTATOR_MAX_MS - SPECTATOR_MIN_MS));
  const timeoutId = setTimeout(async () => {
    if (!run || !running) return;
    // The end-of-run critic review drives the critics directly — regular
    // check-ins wait until it is over.
    if (run.pendingFinish) { scheduleSpectator(key, SPECTATOR_RETRY_MS); return; }
    const ran = await spectatorTurn(key);
    // Skipped because the engine was busy or spectators got toggled off —
    // retry soon instead of waiting a whole random cycle.
    scheduleSpectator(key, ran ? undefined : SPECTATOR_RETRY_MS + Math.random() * 15_000);
  }, delay);
  run.spectators[key] = { timeoutId, firesAt: Date.now() + delay };
  setSpectatorDot(key, 'waiting');
}

function renderSpectatorChips() {
  if (!run) return;
  for (const key of Object.keys(SPECTATORS)) {
    const spec = SPECTATORS[key];
    spec.count().textContent = `${run.stats.spectators[key]} turns`;
    const s = run.spectators[key];
    spec.next().textContent = s ? fmtElapsed(Math.max(0, s.firesAt - Date.now())) : '--:--';
  }
}

function resetSpectatorPanels(note) {
  for (const key of Object.keys(SPECTATORS)) {
    const spec = SPECTATORS[key];
    spec.log().innerHTML = '';
    spec.count().textContent = '0 turns';
    spec.next().textContent = '--:--';
    setSpectatorDot(key, '');
    if (note) metaLog(spec.log(), note);
  }
}

// Hooks installed on worker turns: pause the run during tool execution so no
// agent sneaks in, then resume. Screenshots are no longer pulled automatically;
// the controller must ask the worker to call the capture_screenshot tool.
function makeWorkerHooks() {
  return {
    async onBeforeToolCall() {
      pauseRuns();
      metaLog(agentsWorkerLog, '⏸ runs paused for tool');
    },
    async onAfterToolCall() {
      resumeRuns();
    }
  };
}

// The controller accepted the worker's win — but the run only ends after
// both critics have reviewed the final state and delivered their verdict.
function beginCriticReview(reason, answer) {
  if (!run) { finishRun(reason, answer); return; }
  if (!spectatorsEnabled.checked || !backendSupportsVision()) {
    finishRun(reason, answer);
    return;
  }
  run.pendingFinish = { reason, answer };
  run.paused = true; // freeze controller/worker polling during the review
  run.turnInFlight.controller = false;
  engineBusy = false;
  setStatus('Awaiting critic review…', 'running');
  metaLog(agentsControllerLog, '⚖ stop phrase accepted — awaiting final review from both critics');
  (async () => {
    for (const key of ['a', 'b']) {
      if (!run || !run.pendingFinish) return;
      metaLog(SPECTATORS[key].log(), '⚖ final review requested');
      await spectatorTurn(key,
        `FINAL REVIEW: the controller has declared the task complete.\nFinal answer: "${answer}"\nLook at the console image and give your verdict in 2–3 sentences: does the run look genuinely successful, and why?`);
    }
    if (!run || !run.pendingFinish) return;
    await finishRun(`${run.pendingFinish.reason} · critics reviewed`, run.pendingFinish.answer);
  })();
}

// Chain scheduling: the poll timers alone starve the slower agent when one
// agent's generation spans its whole interval. After every turn, hand the
// engine directly to the other agent if it has pending entries.
async function controllerTurn() {
  const entries = unseenEntries('controller');
  if (!entries.length || !running) return;
  engineBusy = true;
  run.turnInFlight.controller = true;
  for (const e of entries) metaLog(agentsControllerLog, `⇐ ${truncate(formatEntry(e))}`);
  const t0 = performance.now();
  try {
    const payload = formatPayload(entries, 'controller', contextFor('controller', entries));
    logAgent('CONTROLLER TURN START', { entryCount: entries.length, entries: entries.map(e => ({ from: e.from, content: summarizeContent(e.content), meta: e.meta })) });
    logPrompt('controller turn payload', payload);
    let text = await run.sessions.controller.turn(payload, {
      onText: makeStreamTarget(agentsControllerLog),
      onToolCall: () => {},
      onBeforeToolCall: () => {},
      onAfterToolCall: () => {}
    });
    if (!run) return;
    if (run.sessions.controller.lastTurnTimedOut) {
      metaLog(agentsControllerLog, `⏱ cut off at ${run.config.turnCapSeconds}s — continuing with the partial reply`);
      logAgent('CONTROLLER TURN TIMED OUT', { timeLimitS: run.config.turnCapSeconds });
    }
    text = stripEcho(text, entries) || text;
    run.stats.controllerTurns++;
    // The controller must not speak for the worker. Lines in exact bus format
    // ([worker]: / [worker | tool calls: N]: / [tool] server__name:) are
    // fabricated reports — small models pattern-complete the workflow in
    // their prompt and invent the worker's results. Strip them; a stop phrase
    // riding on fabrication is rejected. Note the trailing colon is required:
    // "[worker] Launch Chrome." is the controller ADDRESSING the worker, not
    // fabrication, and must survive.
    const fabricatedRe = /^\s*(?:\[worker(\s*\|[^\]]*)?\]\s*:|\[tool\]\s*\S+__\S*\s*:)/;
    const fabricated = text.split('\n').some(l => fabricatedRe.test(l));
    if (fabricated) {
      text = text.split('\n').filter(l => !fabricatedRe.test(l)).join('\n').trim();
    }
    const hasStopPhrase = text.includes(run.config.stopPhrase);
    // The literal stop phrase never circulates on the bus unless the run is
    // actually finishing — rejected phrases get parroted by the model.
    const controllerText = text
      .replaceAll(run.config.stopPhrase, '[stop-word withheld]')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .trim() || '(no response)';
    logAgent('CONTROLLER TURN END', { durationMs: Math.round(performance.now() - t0), rawText: text, hasStopPhrase, fabricated, controllerText });
    pushBus('controller', controllerText);
    if (hasStopPhrase) {
      // Finishing requires worker reports, verified tool work, and no
      // fabricated evidence — unverified chatter can't end a run.
      const workerHasReported = run.bus.some(e => e.from === 'worker');
      const hasVerifiedWork = run.stats.toolCallsOk > 0 || !run.toolsAvailable;
      if (workerHasReported && hasVerifiedWork && !fabricated) {
        const idx = text.indexOf(run.config.stopPhrase);
        const after = text.slice(idx + run.config.stopPhrase.length).trim();
        const before = text.slice(0, idx).trim();
        const answer = (after || before).replaceAll(run.config.stopPhrase, '').trim();
        beginCriticReview(`Controller satisfied (${run.config.stopPhrase})`, answer);
        return;
      }
      const reason = fabricated
        ? 'your message described worker actions that never happened — only the worker\'s real [tool] reports count'
        : !workerHasReported
          ? 'the worker has not reported any results yet'
          : 'no successful tool call has been made yet — the evidence is unverified';
      pushBus('system', `You used the stop phrase, but ${reason}. The run continues — issue the worker's next single instruction and wait for its real report.`, { forAgent: 'controller' });
      metaLog(agentsControllerLog, `⚠ premature stop rejected — ${reason}`);
    }
  } catch (e) {
    metaLog(agentsControllerLog, `⚠ ${e.message}`);
    logAgent('CONTROLLER TURN ERROR', { error: e.message, durationMs: Math.round(performance.now() - t0) });
  }
  if (run) run.turnInFlight.controller = false;
  engineBusy = false;
  renderStats();
}

async function workerTurn() {
  if (!run || !running) return;
  // Tool results and screenshots are context, not directions. Only spend a
  // worker turn when the controller has actually said something — otherwise
  // the worker free-styles its own agenda off a bare [tool_result].
  const pending = run.bus.slice(run.seen.worker).filter(e => isVisibleTo(e, 'worker'));
  if (!pending.length || !pending.some(e => e.from === 'controller')) return;
  const entries = unseenEntries('worker');
  engineBusy = true;
  run.turnInFlight.worker = true;
  for (const e of entries) metaLog(agentsWorkerLog, `⇐ ${truncate(formatEntry(e))}`);
  const t0 = performance.now();
  try {
    const payload = formatPayload(entries, 'worker', contextFor('worker', entries));
    const hooks = makeWorkerHooks();
    logAgent('WORKER TURN START', { entryCount: entries.length, entries: entries.map(e => ({ from: e.from, content: summarizeContent(e.content), meta: e.meta })) });
    logPrompt('worker turn payload', payload);
    let callsThisTurn = 0;
    const toolResults = [];
    let text = await run.sessions.worker.turn(payload, {
      onText: makeStreamTarget(agentsWorkerLog),
      onToolCall: (call, resultText) => {
        if (!run) return;
        callsThisTurn++;
        toolResults.push({ name: call.function?.name || 'tool', resultText: resultText || '' });
        run.stats.toolCalls++;
        if (resultText && !resultText.startsWith('Error:')) run.stats.toolCallsOk++;
        metaLog(agentsWorkerLog, `🔧 ${call.function?.name || 'tool'}`);
        renderStats();
        logAgent('WORKER TOOL CALL', { name: call.function?.name, resultText: summarizeContent(resultText) });
        // If the worker explicitly asks for a screenshot, capture it and push
        // the image onto its bus for the next turn.
        if (/screenshot|capture_screenshot/i.test(call.function?.name || '')) {
          (async () => {
            try {
              const screenshot = await captureScreenshot();
              if (!run) return;
              if (screenshot) {
                pushBus('system', [{ type: 'image', dataUrl: screenshot, alt: '📷 screenshot requested by worker' }], { forAgent: 'worker', source: 'screenshot' });
                metaLog(agentsWorkerLog, '📷 screenshot captured for worker');
              }
            } catch (e) {
              metaLog(agentsWorkerLog, `⚠ screenshot failed: ${e.message}`);
            }
          })();
        }
      },
      ...hooks
    });
    if (!run) return;
    if (run.sessions.worker.lastTurnTimedOut) {
      metaLog(agentsWorkerLog, `⏱ cut off at ${run.config.turnCapSeconds}s — continuing with the partial reply`);
      logAgent('WORKER TURN TIMED OUT', { timeLimitS: run.config.turnCapSeconds });
    }
    text = stripEcho(text, entries) || text;
    run.stats.workerTurns++;
    // Raw tool-call syntax is execution noise for the controller — strip it,
    // but always tell the controller WHICH tool ran and WHAT it returned,
    // otherwise identical "(tool call executed)" messages make it loop.
    let busText = text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replaceAll(run.config.stopPhrase, '[stop-word withheld]')
      .trim();
    if (toolResults.length) {
      const summary = toolResults.map(r => `[tool] ${r.name}: ${truncate(r.resultText, 400)}`).join('\n');
      busText = busText ? `${busText}\n${summary}` : summary;
    }
    if (!busText) busText = '(no response)';
    logAgent('WORKER TURN END', { durationMs: Math.round(performance.now() - t0), rawText: text, callsThisTurn, busText });
    // The tasks runtime resets session history every turn, so tool results
    // pushed into the session never reach the worker. Deliver them over the
    // bus instead — the worker sees them with the next controller direction.
    for (const r of toolResults) {
      pushBus('system', `[tool_result] ${r.name}: ${r.resultText}`, { forAgent: 'worker', source: 'tool_result' });
    }
    pushBus('worker', busText, { toolCalls: callsThisTurn });
  } catch (e) {
    metaLog(agentsWorkerLog, `⚠ ${e.message}`);
    logAgent('WORKER TURN ERROR', { error: e.message, durationMs: Math.round(performance.now() - t0) });
  }
  if (run) {
    run.turnInFlight.worker = false;
    if (typeof run.sessions.worker.trimHistory === 'function') {
      run.sessions.worker.trimHistory(10);
    }
  }
  engineBusy = false;
  renderStats();
}

async function makeSessions(config) {
  const kind = state.backend.kind;
  const declarations = await mcpManager.listDeclarations();

  const supportsVision = backendSupportsVision();

  if (kind === 'litert') {
    if (!runAgentTurn) {
      const mod = await import('./backends/litert.js');
      runAgentTurn = mod.runAgentTurn;
    }
    const engine = state.backend.engine;
    const capMs = (config.turnCapSeconds || DEFAULT_STREAM_TIME_LIMIT_S) * 1000;
    const controllerPrompt = buildControllerPrompt(config, declarations);
    const workerPrompt = buildWorkerPrompt(config, declarations, 'litert', supportsVision);
    const workerPreface = { messages: [{ role: 'system', content: workerPrompt }] };
    if (declarations.length) workerPreface.tools = declarations;
    logAgent('MAKE SESSIONS litert', { declarations: declarations.map(d => d.function.name) });
    logPrompt('controller (litert)', controllerPrompt);
    logPrompt('worker (litert)', workerPrompt);
    return {
      controller: new LitertAgentSession(await engine.createConversation({
        preface: { messages: [{ role: 'system', content: controllerPrompt }] }
      }), false, capMs),
      worker: new LitertAgentSession(await engine.createConversation({ preface: workerPreface }), true, capMs),
      runtimeLabel: 'LiteRT-LM (native tools)'
    };
  }

  if (kind === 'tasks') {
    const controllerPrompt = buildControllerPrompt(config, declarations);
    const workerPrompt = buildWorkerPrompt(config, declarations, 'tasks', supportsVision);
    logAgent('MAKE SESSIONS tasks', { declarations: declarations.map(d => d.function.name) });
    logPrompt('controller (tasks)', controllerPrompt);
    logPrompt('worker (tasks)', workerPrompt);
    const capMs = (config.turnCapSeconds || DEFAULT_STREAM_TIME_LIMIT_S) * 1000;
    return {
      controller: new TasksAgentSession(state.backend, controllerPrompt, false, declarations, capMs),
      worker: new TasksAgentSession(state.backend, workerPrompt, true, declarations, capMs),
      runtimeLabel: 'tasks-genai (prompt-based tools)'
    };
  }

  throw new Error(`Agent runs are not supported on the "${kind}" runtime`);
}

async function finishRun(reason, finalAnswer = '') {
  if (!running) return;
  logAgent('FINISH RUN', { reason, finalAnswer, stats: run?.stats, elapsedMs: Date.now() - (run?.startedAt || Date.now()) });
  running = false;
  state.agentRunning = false;
  agentsBadge.classList.add('hidden');
  for (const t of run.timers) clearInterval(t);
  for (const s of Object.values(run.spectators || {})) {
    if (s?.timeoutId) clearTimeout(s.timeoutId);
  }
  for (const key of Object.keys(SPECTATORS)) setSpectatorDot(key, '');
  try {
    await run.sessions.controller.dispose();
    await run.sessions.worker.dispose();
    for (const sess of Object.values(run.spectatorSessions || {})) await sess.dispose();
  } catch { /* sessions may already be gone */ }

  run.finalAnswer = finalAnswer;
  setStatus(`Finished — ${reason}`, 'ok');
  agentsStart.disabled = false;
  agentsStop.disabled = true;

  if (finalAnswer) {
    agentsFinal.classList.remove('hidden');
    agentsFinal.innerHTML = `<div class="agents-final-title">Final answer</div><div>${escapeHtml(finalAnswer)}</div>`;
  }

  try {
    const record = {
      id: crypto.randomUUID(),
      task: run.config.task,
      model: state.currentModel || null,
      runtime: run.sessions.runtimeLabel,
      startedAt: run.startedAt,
      endedAt: Date.now(),
      stopReason: reason,
      validated: false,
      finalAnswer,
      config: run.config,
      stats: run.stats,
      transcript: run.bus,
      spectatorLog: run.spectatorLog || []
    };
    await idbPutAgentRun(record);
    displayedRun = record;
    dispatchRunsChanged();
    toast('Agent run saved to history.', 'success', 2600);
  } catch (e) {
    console.warn('Agent run persistence failed:', e);
  }
  run = null;
  setExportValidatedState();
}

async function startRun() {
  if (running) return;
  if (!state.backend || (state.backend.kind !== 'litert' && state.backend.kind !== 'tasks')) {
    toast('Agent runs need the LiteRT-LM or tasks-genai runtime — mount one first.', 'warning', 4200);
    return;
  }
  if (state.generating) {
    toast('Wait for the current chat reply to finish.', 'warning', 3000);
    return;
  }
  // Use a fresh random stop phrase for every run so models cannot memorize
  // or accidentally parrot a fixed phrase.
  agentsStopPhrase.value = generateStopPhrase();

  const config = readConfig();
  logAgent('START RUN CONFIG', {
    task: config.task,
    stopPhrase: config.stopPhrase,
    controllerInterval: config.controllerInterval,
    workerInterval: config.workerInterval,
    maxMinutes: config.maxMinutes,
    controllerPromptLength: config.controllerPrompt.length,
    workerPromptLength: config.workerPrompt.length,
    controllerPrompt: config.controllerPrompt,
    workerPrompt: config.workerPrompt
  });
  if (!config.task) {
    toast('Enter a task for the agents first.', 'warning', 3000);
    return;
  }

  agentsControllerLog.innerHTML = '';
  agentsWorkerLog.innerHTML = '';
  agentsFinal.classList.add('hidden');
  agentsFinal.innerHTML = '';
  resetSpectatorPanels();

  let sessions;
  try {
    sessions = await makeSessions(config);
  } catch (e) {
    toast('Could not create agent sessions: ' + e.message, 'error', 5000);
    return;
  }

  const declarations = await mcpManager.listDeclarations();
  const toolCount = declarations.length;
  logAgent('TOOL DECLARATIONS', { count: toolCount, names: declarations.map(d => d.function.name) });
  if (!toolCount) {
    toast('No MCP servers connected — the worker has no tools and can only talk.', 'warning', 4500);
  }

  running = true;
  state.agentRunning = true;
  agentsBadge.classList.remove('hidden');
  run = {
    bus: [],
    seen: { controller: 0, worker: 0 },
    stats: { controllerTurns: 0, workerTurns: 0, toolCalls: 0, toolCallsOk: 0, spectators: { a: 0, scout: 0, b: 0 } },
    turnInFlight: { controller: false, worker: false },
    timers: [],
    spectators: {},
    spectatorSessions: {},
    paused: false,
    sessions,
    config,
    toolsAvailable: toolCount > 0,
    startedAt: Date.now(),
    finalAnswer: '',
    spectatorLog: [],
    lastScoutDescription: null,
    pendingFinish: null
  };
  pushBus('user', config.task);
  logAgent('RUN STATE INIT', { runtime: sessions.runtimeLabel, stats: run.stats, seen: run.seen });

  agentsStart.disabled = true;
  agentsStop.disabled = false;
  displayedRun = null;
  setExportValidatedState();
  setStatus(`Running · ${sessions.runtimeLabel}`, 'running');
  metaLog(agentsControllerLog, `task: ${config.task}`);
  metaLog(agentsControllerLog, `stop phrase: ${config.stopPhrase}`);
  metaLog(agentsWorkerLog, 'waiting for controller directions…');

  // Spectators ride along with the run — random 1–2 min check-ins. They need
  // vision to read images; without it they stay idle with a note.
  if (spectatorsEnabled.checked) {
    if (backendSupportsVision()) {
      for (const key of Object.keys(SPECTATORS)) {
        metaLog(SPECTATORS[key].log(), 'waiting for first check-in…');
        scheduleSpectator(key);
      }
    } else {
      for (const key of Object.keys(SPECTATORS)) {
        metaLog(SPECTATORS[key].log(), '⚠ enable the Vision toggle to activate spectators');
      }
    }
  } else {
    for (const key of Object.keys(SPECTATORS)) metaLog(SPECTATORS[key].log(), 'spectators disabled');
  }

  run.timers.push(setInterval(() => {
    if (running && !run.paused && !engineBusy && !run.turnInFlight.controller) controllerTurn();
  }, config.controllerInterval * 1000));
  run.timers.push(setInterval(() => {
    if (running && !run.paused && !engineBusy && !run.turnInFlight.worker) workerTurn();
  }, config.workerInterval * 1000));
  run.timers.push(setInterval(() => {
    renderStats();
    if (Date.now() - run.startedAt > config.maxMinutes * 60 * 1000) {
      finishRun(`Time limit reached (${config.maxMinutes} min)`);
    }
  }, 1000));

  // Kick off the controller's first look at the task immediately.
  controllerTurn();
}

// ============================================================
// Saved runs — sidebar list, viewing, validation, export
// ============================================================
let displayedRun = null; // saved run record currently shown (export/validate target)

function dispatchRunsChanged() {
  window.dispatchEvent(new CustomEvent('combs:agent-runs-changed'));
}

// Export works on the live run too; validation only on saved records.
function setExportValidatedState() {
  agentsExport.disabled = !(running && run) && !displayedRun;
  agentsValidated.disabled = !displayedRun;
  agentsValidated.checked = !!displayedRun?.validated;
}

export async function renderRunList(container) {
  let runs = [];
  try { runs = await idbGetAgentRuns(); } catch (e) { console.warn(e); }
  container.innerHTML = '';
  if (!runs.length) {
    container.innerHTML = '<div class="chat-list-empty">No saved runs yet.<br>Start a run — it saves automatically when it finishes.</div>';
    return;
  }
  const label = document.createElement('div');
  label.className = 'chat-list-label';
  label.textContent = 'Agent runs';
  container.appendChild(label);

  for (const r of runs) {
    const item = document.createElement('div');
    item.className = 'chat-item run-item' + (displayedRun?.id === r.id ? ' active' : '');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>
      <span class="chat-item-title">${escapeHtml(r.task || '(untitled run)')}</span>
      ${r.validated ? '<span class="run-validated" title="Validated run">✓</span>' : ''}
      <button class="chat-item-delete" aria-label="Delete run" title="Delete run">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`;
    const open = () => loadRunRecord(r);
    item.addEventListener('click', (e) => {
      if (e.target.closest('.chat-item-delete')) return;
      open();
    });
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    item.querySelector('.chat-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirmModal({
        title: 'Delete run',
        message: `Delete run "${(r.task || '').slice(0, 60)}"? This cannot be undone.`,
        confirmText: 'Delete',
        onConfirm: async () => {
          try { await idbDeleteAgentRun(r.id); } catch (err) { console.warn(err); }
          if (displayedRun?.id === r.id) displayedRun = null;
          toast('Run deleted', 'info', 2500);
          dispatchRunsChanged();
          hideConfirmModal();
          setExportValidatedState();
        }
      });
    });
    container.appendChild(item);
  }
}

function loadRunRecord(r) {
  if (running) {
    toast('A run is in progress — stop it to view saved runs.', 'warning', 3000);
    return;
  }
  displayedRun = r;
  agentsControllerLog.innerHTML = '';
  agentsWorkerLog.innerHTML = '';
  resetSpectatorPanels();

  for (const entry of r.transcript || []) {
    const el = entry.from === 'controller' ? agentsControllerLog
      : entry.from === 'worker' ? agentsWorkerLog
      : null;
    const content = entry.content ?? entry.text ?? '';
    if (el) {
      const div = document.createElement('div');
      div.className = 'agents-msg';
      div.textContent = Array.isArray(content)
        ? (content.find(p => p.alt)?.alt || '📷 image')
        : content;
      el.appendChild(div);
    } else {
      metaLog(agentsControllerLog, `[${entry.from}] ${Array.isArray(content) ? '📷 image' : content}`);
    }
  }

  // Replay spectator turns (critics + scout) into their panels.
  for (const s of r.spectatorLog || []) {
    const spec = SPECTATORS[s.agent];
    if (!spec) continue;
    const alt = s.kind === 'mcp' ? '📷 MCP screenshot' : '🖥 agent page';
    metaLog(spec.log(), `⇐ ${alt}`);
    if (s.image) imageLog(spec.log(), s.image, alt);
    const div = document.createElement('div');
    div.className = 'agents-msg';
    div.textContent = s.text || '';
    spec.log().appendChild(div);
    spec.log().scrollTop = spec.log().scrollHeight;
  }
  for (const key of Object.keys(SPECTATORS)) {
    SPECTATORS[key].count().textContent = `${r.stats?.spectators?.[key] ?? 0} turns`;
  }

  if (r.finalAnswer) {
    agentsFinal.classList.remove('hidden');
    agentsFinal.innerHTML = `<div class="agents-final-title">Final answer</div><div>${escapeHtml(r.finalAnswer)}</div>`;
  } else {
    agentsFinal.classList.add('hidden');
    agentsFinal.innerHTML = '';
  }
  setStatus(`Viewing saved run — ${r.stopReason}`);
  const sp = r.stats?.spectators;
  agentsStats.textContent = `turns C:${r.stats?.controllerTurns ?? '?'} · W:${r.stats?.workerTurns ?? '?'} · tools:${r.stats?.toolCalls ?? '?'}`
    + (sp ? ` · A:${sp.a} · S:${sp.scout} · B:${sp.b}` : '');
  agentsElapsed.textContent = fmtElapsed((r.endedAt || r.startedAt) - r.startedAt);
  setExportValidatedState();
  dispatchRunsChanged(); // refresh sidebar so the loaded run shows as active
}

// ---- Export ----

function exportImageBlock(dataUrl) {
  const mime = (dataUrl.match(/^data:([^;,]+)/) || [])[1] || 'image';
  return `<<IMAGE ${mime} base64>>\n${dataUrl}\n<<END IMAGE>>`;
}

function contentToExportText(content) {
  if (Array.isArray(content)) {
    return content.map(p => {
      if (p.type === 'image' && p.dataUrl) return `${p.alt || '📷 image'}\n${exportImageBlock(p.dataUrl)}`;
      if (p.type === 'text') return p.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(content ?? '');
}

const SPECTATOR_EXPORT_LABELS = {
  a: 'CRITIC A (performance)',
  scout: 'SCOUT (MCP screenshot description)',
  b: 'CRITIC B (efficiency)'
};

function buildRunExport(rec) {
  const sp = rec.stats?.spectators;
  const lines = [
    'COMBSLLM AGENT RUN EXPORT',
    '='.repeat(60),
    `Task: ${rec.task || ''}`,
    `Model: ${rec.model ? getModelName(rec.model) : '(unknown)'}`,
    `Runtime: ${rec.runtime || '(unknown)'}`,
    `Started: ${new Date(rec.startedAt).toISOString()}`,
    `Ended: ${rec.endedAt ? new Date(rec.endedAt).toISOString() : '(in progress)'}`,
    `Duration: ${fmtElapsed((rec.endedAt || Date.now()) - rec.startedAt)}`,
    `Stop reason: ${rec.stopReason || '(in progress)'}`,
    `Validated: ${rec.validated ? 'yes' : 'no'}`,
    `Stats: controller turns ${rec.stats?.controllerTurns ?? 0} · worker turns ${rec.stats?.workerTurns ?? 0} · tool calls ${rec.stats?.toolCalls ?? 0} · critic A ${sp?.a ?? 0} · scout ${sp?.scout ?? 0} · critic B ${sp?.b ?? 0}`
  ];
  if (rec.finalAnswer) lines.push(`Final answer: ${rec.finalAnswer}`);
  lines.push('', 'TIMELINE (merged, chronological)', '='.repeat(60));

  const events = [];
  for (const e of rec.transcript || []) {
    events.push({
      t: e.t,
      label: (e.from || 'system').toUpperCase(),
      text: contentToExportText(e.content ?? e.text ?? '')
    });
  }
  for (const s of rec.spectatorLog || []) {
    const img = s.image ? `\n${exportImageBlock(s.image)}` : '';
    events.push({
      t: s.t,
      label: SPECTATOR_EXPORT_LABELS[s.agent] || (s.agent || 'spectator').toUpperCase(),
      text: `${s.text || ''}${img}`
    });
  }
  events.sort((a, b) => a.t - b.t);
  for (const ev of events) {
    lines.push('', `[${new Date(ev.t).toISOString()}] ${ev.label}:`);
    lines.push(ev.text || '(no content)');
  }
  lines.push('');
  return lines.join('\n');
}

// The record to export: the live run while one is in progress, else the
// saved run being viewed.
function currentRunRecord() {
  if (running && run) {
    return {
      task: run.config.task,
      model: state.currentModel || null,
      runtime: run.sessions.runtimeLabel,
      startedAt: run.startedAt,
      endedAt: null,
      stopReason: 'in progress',
      validated: false,
      stats: run.stats,
      finalAnswer: '',
      transcript: run.bus,
      spectatorLog: run.spectatorLog || []
    };
  }
  return displayedRun;
}

function exportRun() {
  const rec = currentRunRecord();
  if (!rec) {
    toast('Nothing to export yet — run the agents or open a saved run.', 'warning', 3000);
    return;
  }
  const txt = buildRunExport(rec);
  const slug = (rec.task || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
  const d = new Date(rec.startedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `agent-run-${stamp}-${slug}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Run exported as .txt', 'success', 2600);
}

// ---- View switching & form ----

export function enterAgentsView() {
  if (state.view === 'agents') return;
  state.view = 'agents';
  consolePanel.classList.add('view-hidden');
  chatScroll.classList.add('view-hidden');
  composer.classList.add('view-hidden');
  agentsPage.classList.remove('hidden');
  headerTitle.textContent = 'Agent Orchestrator';
  newChatBtnLabel.textContent = 'New run';
  // The settings (sliders) header button drives Prompts & timing here.
  toggleConsoleBtn.classList.toggle('active', agentsSettings.open);
}

export function exitAgentsView() {
  if (state.view !== 'agents') return;
  state.view = 'chat';
  agentsPage.classList.add('hidden');
  consolePanel.classList.remove('view-hidden');
  chatScroll.classList.remove('view-hidden');
  composer.classList.remove('view-hidden');
  newChatBtnLabel.textContent = 'New chat';
  toggleConsoleBtn.classList.toggle('active', !consolePanel.classList.contains('collapsed'));
  headerTitle.textContent = state.activeMessagesLog.some(m => m.role === 'user')
    ? deriveTitle(state.activeMessagesLog)
    : 'New chat';
}

// "New run" — fresh page with default settings, ready for a task.
export function resetAgentsForm() {
  if (running) {
    toast('Stop the current run before starting a new one.', 'warning', 3000);
    return;
  }
  displayedRun = null;
  agentsTask.value = '';
  agentsControllerPrompt.value = DEFAULT_CONTROLLER_PROMPT;
  agentsWorkerPrompt.value = DEFAULT_WORKER_PROMPT;
  agentsControllerInterval.value = '30';
  agentsWorkerInterval.value = '10';
  agentsMaxMinutes.value = '30';
  agentsTurnCap.value = String(DEFAULT_STREAM_TIME_LIMIT_S);
  agentsStopPhrase.value = generateStopPhrase();
  agentsBadge.classList.add('hidden');
  agentsControllerLog.innerHTML = '';
  agentsWorkerLog.innerHTML = '';
  agentsFinal.classList.add('hidden');
  agentsFinal.innerHTML = '';
  resetSpectatorPanels();
  setStatus('Idle');
  agentsStats.textContent = 'turns C:0 · W:0 · tools:0';
  agentsElapsed.textContent = '0:00';
  agentsStart.disabled = false;
  agentsStop.disabled = true;
  setExportValidatedState();
  agentsTask.focus();
}

export function initAgents() {
  // Always load defaults at runtime — no localStorage persistence.
  agentsControllerPrompt.value = DEFAULT_CONTROLLER_PROMPT;
  agentsWorkerPrompt.value = DEFAULT_WORKER_PROMPT;
  agentsControllerInterval.value = '30';
  agentsWorkerInterval.value = '10';
  agentsMaxMinutes.value = '30';
  agentsTurnCap.value = String(DEFAULT_STREAM_TIME_LIMIT_S);
  agentsStopPhrase.value = '';

  agentsBtn.addEventListener('click', () => {
    if (state.view === 'agents') exitAgentsView();
    else enterAgentsView();
    window.dispatchEvent(new CustomEvent('combs:view-changed'));
  });
  agentsStart.addEventListener('click', startRun);
  agentsStop.addEventListener('click', () => finishRun('Stopped by user'));
  agentsExport.addEventListener('click', exportRun);
  agentsValidated.addEventListener('change', async () => {
    if (!displayedRun) {
      agentsValidated.checked = false;
      return;
    }
    displayedRun.validated = agentsValidated.checked;
    try {
      await idbPutAgentRun(displayedRun);
      toast(displayedRun.validated ? 'Run marked as validated ✓' : 'Validation cleared', 'success', 2200);
      dispatchRunsChanged();
    } catch (e) {
      toast('Could not save validation: ' + e.message, 'error', 4000);
    }
  });
  setExportValidatedState();
}
