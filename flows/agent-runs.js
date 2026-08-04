// ============================================================
// Agent runs, rebuilt on the Vercel AI SDK (ToolLoopAgent).
// One structured run = one agent.stream() call: the SDK drives the
// multi-step loop (generate -> execute tools -> feed results back),
// bounded by stopWhen (step cap + final_answer tool). No poll timers,
// no message bus, no stop-phrase heuristics.
//
// The on-device LiteRT-LM engine is exposed to the SDK through the
// custom LanguageModel in backends/ai-sdk-litert.js; tools come from
// connected MCP servers (js/mcp.js). Runs persist to the agent-runs
// store as structured step events.
// ============================================================
import {
  agentsBtn, agentsPage, agentsTask, agentsStart, agentsStop,
  agentsControllerPrompt, agentsMaxSteps, agentsMaxMinutes,
  agentsStatusText, agentsElapsed, agentsStats, agentsExport, agentsSpawnPod,
  agentsBadge, agentsSettings, toggleConsoleBtn,
  agentsControllerLog, agentsWorkerLog, agentsFinal,
  consolePanel, chatScroll, composer, headerTitle, newChatBtnLabel
} from '../atoms/dom.js';
import { state } from '../atoms/state.js';
import { toast, showConfirmModal, hideConfirmModal } from '../atoms/ui.js';
import { escapeHtml, deriveTitle } from '../atoms/text.js';
import { mcpManager, captureScreenshot } from '../atoms/mcp.js';
import { idbPutAgentRun, idbGetAgentRuns, idbDeleteAgentRun } from '../atoms/store.js';
import { getModelName, getModelDef, modelDownloadUrl } from '../atoms/config.js';
import { createLitertLanguageModel } from '../atoms/backends/ai-sdk-litert.js';
import { createTasksLanguageModel } from '../atoms/backends/ai-sdk-tasks.js';
import { compactMessages } from '../atoms/context-budget.js';

// The AI SDK (~260 KB from esm.sh) is loaded lazily on the first run so the
// initial page boot is not blocked on the CDN module graph.
let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import('../atoms/ai-sdk.js');
  return sdkPromise;
}

const FORM_KEYS = {
  prompt: 'combsllm.agents.prompt',
  maxSteps: 'combsllm.agents.maxSteps',
  maxMinutes: 'combsllm.agents.maxMinutes'
};

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_MINUTES = 30;
// Agent runs truncate MCP tool results harder than chat — small on-device
// models can't use 4k of tool output, and it quadruples context growth.
const MAX_TOOL_RESULT_CHARS = 1000;
const DEBUG_AGENTS = false;

function debug(...args) {
  if (DEBUG_AGENTS) console.debug('[agents]', ...args);
}

export const DEFAULT_AGENT_PROMPT = `You are an autonomous browsing agent. You complete the user's task by calling tools, one step at a time.

User's task: {{task}}

Rules:
- Work step by step: decide the next single action, call the tool, read its result, then continue.
- Never invent tool results — only trust what tools actually returned.
- Take a screenshot (capture_screenshot) whenever you need to see what is on the page.
- Do NOT use get_source or the browser console.
- When the task is complete and verified by real tool results, call the final_answer tool with your report. Do not call final_answer before you have verified results.

Search workflow (preferred):
1. Navigate to https://duckduckgo.com.
2. Type the search query into the search box.
3. Press Enter.
4. Take a screenshot to see the results.
5. Scroll if needed, then click the best result.
6. Verify the answer with screenshots.

Tools:
{{tools}}`;

const FINAL_ANSWER_TOOL = 'final_answer';

// ============================================================
// Tools
// ============================================================

function formatToolDoc({ name, description, parameters }) {
  const params = parameters || {};
  const props = params.properties || {};
  const required = new Set(params.required || []);
  const args = Object.entries(props).map(([pname, schema]) => {
    const req = required.has(pname) ? 'required' : 'optional';
    return `${pname} (${req}, ${schema.type || 'any'})`;
  }).join(', ') || 'none';
  return `- ${name}: ${description} | args: { ${args} }`;
}

// Whether the mounted backend can actually see images we feed it.
function backendSupportsVision() {
  if (!state.backend) return false;
  if (state.backend.kind === 'litert') return !!state.backend.modalities?.vision;
  if (state.backend.kind === 'tasks') return !!state.backend.vision;
  return false;
}

// MCP tool declarations -> AI SDK tools, plus the doc list of exactly the
// tools that were registered (the prompt must never advertise a tool the
// agent cannot actually call). Tool errors are returned as "Error: ..."
// results (not thrown) so the model can read and recover.
function buildSdkTools(sdk, declarations) {
  const { tool, jsonSchema } = sdk;
  const tools = {};
  const toolDocs = [];
  for (const decl of declarations) {
    const fn = decl.function;
    // The synthetic screenshot tool is superseded by the native one below,
    // which returns the image to the model inside the step loop.
    if (fn.name === 'synthetic__capture_screenshot') continue;
    tools[fn.name] = tool({
      description: fn.description,
      inputSchema: jsonSchema(fn.parameters?.type === 'object' ? fn.parameters : { type: 'object', properties: {} }),
      execute: async (input) => {
        try {
          const text = await mcpManager.callTool(fn.name, input || {});
          return text.length > MAX_TOOL_RESULT_CHARS
            ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
            : text;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }
    });
    toolDocs.push({ name: fn.name, description: fn.description, parameters: fn.parameters });
  }

  // Screenshots only make sense when the model can see the result.
  if (backendSupportsVision()) {
    tools.capture_screenshot = tool({
      description: 'Capture a screenshot of the current browser page and see it as an image.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => {
        const dataUrl = await captureScreenshot();
        if (!dataUrl) return { error: 'no browser screenshot tool is connected' };
        if (run) run.screenshots.push({ t: Date.now(), dataUrl });
        return dataUrl;
      },
      toModelOutput: ({ output }) => {
        if (typeof output === 'string' && output.startsWith('data:image')) {
          const mime = (output.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
          return {
            type: 'content',
            value: [
              { type: 'text', text: 'Screenshot captured.' },
              { type: 'file', data: { type: 'data', data: output.slice(output.indexOf(',') + 1) }, mediaType: mime }
            ]
          };
        }
        return { type: 'json', value: output };
      }
    });
    toolDocs.push({ name: 'capture_screenshot', description: 'Capture a screenshot of the current browser page and see it as an image.', parameters: { type: 'object', properties: {} } });
  }

  // No execute: calling this tool stops the loop and yields the structured
  // final report (validated by the SDK against this schema).
  const finalAnswerSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'The final answer to the user\'s task.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'The verified steps taken.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'URLs or evidence used.' }
    },
    required: ['summary']
  };
  tools[FINAL_ANSWER_TOOL] = tool({
    description: 'Submit the final answer and end the run. Call only when the task is complete and verified.',
    inputSchema: jsonSchema(finalAnswerSchema)
  });
  toolDocs.push({ name: FINAL_ANSWER_TOOL, description: 'Submit the final answer and end the run. Call only when the task is complete and verified.', parameters: finalAnswerSchema });

  return { tools, toolDocs };
}

function buildInstructions(config, toolDocs) {
  const docs = toolDocs.length
    ? toolDocs.map(formatToolDoc).join('\n')
    : '(no tools connected)';
  return config.prompt
    .replaceAll('{{task}}', config.task)
    .replaceAll('{{tools}}', docs);
}

// ============================================================
// Run state (one run at a time, enforced by app-level guards)
// ============================================================
let running = false;
let run = null;

const truncate = (t, n = 200) => (t.length > n ? `${t.slice(0, n)}…` : t);

function metaLog(el, text) {
  const div = document.createElement('div');
  div.className = 'agents-meta';
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// Streaming text target: one message div per step.
function makeStreamTarget(el) {
  let span = null;
  return {
    write(chunk) {
      if (!span) {
        const div = document.createElement('div');
        div.className = 'agents-msg';
        span = document.createElement('span');
        div.appendChild(span);
        el.appendChild(div);
      }
      span.textContent += chunk;
      el.scrollTop = el.scrollHeight;
    },
    reset() { span = null; }
  };
}

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

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderStats() {
  if (!run) return;
  agentsStats.textContent = `steps:${run.stats.steps} · tools:${run.stats.toolCalls} · cycles:${run.stats.cycles}`;
  agentsElapsed.textContent = fmtElapsed(Date.now() - run.startedAt);
}

function setStatus(text, cls = '') {
  agentsStatusText.textContent = text;
  agentsStatusText.className = 'agents-status-text ' + cls;
}

function readConfig() {
  return {
    task: agentsTask.value.trim(),
    prompt: agentsControllerPrompt.value,
    maxSteps: Math.min(100, Math.max(1, parseInt(agentsMaxSteps.value) || DEFAULT_MAX_STEPS)),
    maxMinutes: Math.min(180, Math.max(1, parseInt(agentsMaxMinutes.value) || DEFAULT_MAX_MINUTES))
  };
}

function persistForm() {
  localStorage.setItem(FORM_KEYS.prompt, agentsControllerPrompt.value);
  localStorage.setItem(FORM_KEYS.maxSteps, agentsMaxSteps.value);
  localStorage.setItem(FORM_KEYS.maxMinutes, agentsMaxMinutes.value);
}

function recordEvent(kind, data = {}) {
  if (!run) return;
  run.events.push({ t: Date.now(), kind, ...data });
}

// Render one part of the SDK stream and record it for persistence.
function handleStreamPart(part, agentStream) {
  switch (part.type) {
    case 'start-step':
      agentStream.reset();
      break;
    case 'text-delta':
      agentStream.write(part.text);
      run.textBuf = (run.textBuf || '') + part.text;
      break;
    case 'tool-call': {
      run.stats.toolCalls++;
      const preview = truncate(JSON.stringify(part.input ?? {}), 160);
      metaLog(agentsWorkerLog, `🔧 ${part.toolName}(${preview})`);
      recordEvent('tool-call', { name: part.toolName, input: part.input ?? {}, toolCallId: part.toolCallId });
      if (part.toolName === FINAL_ANSWER_TOOL) {
        run.finalReport = part.input || {};
        run.finalCallId = part.toolCallId;
      }
      if (part.toolName === 'capture_screenshot') metaLog(agentsWorkerLog, '📷 capturing screenshot…');
      renderStats();
      break;
    }
    case 'tool-result': {
      const isShot = part.toolName === 'capture_screenshot';
      const text = isShot && typeof part.output === 'string' && part.output.startsWith('data:image')
        ? 'screenshot captured'
        : truncate(typeof part.output === 'string' ? part.output : JSON.stringify(part.output), 300);
      metaLog(agentsWorkerLog, `✓ ${part.toolName}: ${text}`);
      if (isShot && run.screenshots.length) {
        imageLog(agentsWorkerLog, run.screenshots[run.screenshots.length - 1].dataUrl, '📷 screenshot');
      }
      recordEvent('tool-result', { name: part.toolName, output: text });
      break;
    }
    case 'tool-error':
      metaLog(agentsWorkerLog, `✗ ${part.toolName}: ${truncate(String(part.error), 200)}`);
      recordEvent('tool-error', { name: part.toolName, error: String(part.error) });
      break;
    case 'finish-step':
      run.stats.steps++;
      metaLog(agentsControllerLog, `— step ${run.stats.steps} done (${part.finishReason?.unified ?? part.finishReason ?? 'stop'}) —`);
      recordEvent('step', { n: run.stats.steps, finishReason: part.finishReason?.unified ?? String(part.finishReason ?? '') });
      if (run.textBuf) {
        recordEvent('text', { step: run.stats.steps, text: run.textBuf });
        run.textBuf = '';
      }
      renderStats();
      break;
    case 'error':
      metaLog(agentsControllerLog, `⚠ ${part.error?.message || String(part.error)}`);
      recordEvent('error', { error: part.error?.message || String(part.error) });
      break;
    default:
      break; // start, text-start/end, finish, abort — handled elsewhere
  }
}

function formatFinalReport(report) {
  if (!report || typeof report !== 'string' && !report.summary) return '';
  if (typeof report === 'string') return report;
  const parts = [report.summary || ''];
  if (report.steps?.length) parts.push('\nSteps:\n' + report.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  if (report.sources?.length) parts.push('\nSources:\n' + report.sources.map(s => `- ${s}`).join('\n'));
  return parts.join('\n');
}

// ============================================================
// Supervisor: three agent roles on the same mounted model.
//   EXECUTOR   — the ToolLoopAgent loop above (does the work)
//   VALIDATOR  — one-shot judge: is the task answered, with evidence?
//   STRATEGIST — one-shot recovery planner when tools keep failing
// The supervisor resumes the executor from its accumulated messages
// with targeted feedback, bounded by a cycle cap and the run budget.
// ============================================================
const MAX_SUPERVISOR_CYCLES = 4;

const VALIDATOR_PROMPT = `You are the VALIDATOR, a strict reviewer inside an agentic system. You judge whether an agent has actually completed the user's task, based only on the evidence shown (real tool calls and their results).

Rules:
- ANSWERED only if the claimed answer addresses the task AND is supported by the tool results shown. Vague, unverified or invented answers are NOT_ANSWERED.
- If there is no claimed answer, judge whether the transcript already contains a supported answer.
- Reply in EXACTLY this format, nothing else:
VERDICT: ANSWERED
or
VERDICT: NOT_ANSWERED: <one short sentence: what is missing and what the agent should do next>`;

const STRATEGIST_PROMPT = `You are the STRATEGIST, a recovery planner inside an agentic system. An agent executing a task got stuck: its recent tool calls failed. You receive the task, what happened, and the available tools. Produce a revised plan of at most 3 concrete steps.

Rules:
- Use only the listed tools, with exact names and example arguments.
- For web searches prefer DuckDuckGo: navigate to https://duckduckgo.com, type the query, press Enter, take a screenshot to read results.
- Never suggest get_source or the browser console.
- Be brief: numbered steps, no commentary.`;

// Compact evidence transcript for the validator/strategist.
function buildEvidenceDigest(maxChars = 2200) {
  const lines = [];
  for (const ev of run.events) {
    if (ev.kind === 'tool-call') lines.push(`TOOL ${ev.name}(${truncate(JSON.stringify(ev.input ?? {}), 120)})`);
    else if (ev.kind === 'tool-result') lines.push(`  -> ${truncate(ev.output, 220)}`);
    else if (ev.kind === 'tool-error') lines.push(`  -> ERROR ${truncate(ev.error, 160)}`);
    else if (ev.kind === 'text') lines.push(`AGENT: ${truncate(ev.text, 200)}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = '…(earlier evidence omitted)\n' + out.slice(-maxChars);
  return out || '(no tool calls yet)';
}

// Stuck detector: of the last few tool results, most are errors.
function recentToolErrorStreak(lookback = 3, threshold = 2) {
  const results = run.events.filter(e => e.kind === 'tool-result').slice(-lookback);
  if (results.length < threshold) return false;
  const errors = results.filter(e => typeof e.output === 'string' && e.output.startsWith('Error:'));
  return errors.length >= threshold;
}

function lastAgentText() {
  const texts = run.events.filter(e => e.kind === 'text');
  return texts.length ? truncate(texts[texts.length - 1].text.trim(), 600) : '';
}

function parseVerdict(text) {
  const m = (text || '').match(/VERDICT:\s*(ANSWERED|NOT_ANSWERED)\s*:?[\s-]*/i);
  if (!m) return null;
  return {
    answered: m[1].toUpperCase() === 'ANSWERED',
    reason: text.slice(m.index + m[0].length).trim() || '(no reason given)',
    text
  };
}

// One-shot role call (validator or strategist). Returns null when the run
// was aborted mid-call; on other failures returns the fallback so the
// supervisor can keep moving.
async function supervisorCall(kind, prompt, fallback, generateText, model) {
  const label = kind === 'validator' ? '⚖ validator' : '🧭 strategist';
  try {
    const res = await generateText({
      model,
      instructions: kind === 'validator' ? VALIDATOR_PROMPT : STRATEGIST_PROMPT,
      prompt,
      abortSignal: run.abort.signal
    });
    const text = (res.text || '').trim();
    debug(`${kind} output`, text);
    if (kind === 'validator') {
      const parsed = parseVerdict(text) || fallback;
      metaLog(agentsControllerLog, `${label}: ${parsed.answered ? 'answered ✓' : `not answered — ${parsed.reason}`}`);
      recordEvent('validator', { verdict: parsed.answered ? 'answered' : 'not_answered', reason: parsed.reason, text });
      run.verdicts.push({ answered: parsed.answered, reason: parsed.reason, t: Date.now() });
      return parsed;
    }
    metaLog(agentsControllerLog, `${label}: revised plan`);
    const div = document.createElement('div');
    div.className = 'agents-msg';
    div.textContent = text || fallback;
    agentsControllerLog.appendChild(div);
    agentsControllerLog.scrollTop = agentsControllerLog.scrollHeight;
    recordEvent('strategist', { text: text || fallback });
    return text || fallback;
  } catch (e) {
    if (!run || run.abort.signal.aborted) return null;
    metaLog(agentsControllerLog, `⚠ ${kind} failed: ${e.message}`);
    recordEvent('error', { error: `${kind} failed: ${e.message}` });
    return fallback;
  }
}

async function finishRun(reason, finalAnswer = '') {
  if (!running) return;
  running = false;
  state.agentRunning = false;
  agentsBadge.classList.add('hidden');
  clearTimeout(run.deadlineTimer);
  clearInterval(run.tickTimer);

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
      runtime: run.runtimeLabel,
      startedAt: run.startedAt,
      endedAt: Date.now(),
      stopReason: reason,
      finalAnswer,
      finalReport: run.finalReport || null,
      config: run.config,
      stats: run.stats,
      supervisor: { cycles: run.stats.cycles, verdicts: run.verdicts },
      events: run.events
    };
    await idbPutAgentRun(record);
    displayedRun = record;
    dispatchRunsChanged();
    toast('Agent run saved to history.', 'success', 2600);
  } catch (e) {
    console.warn('Agent run persistence failed:', e);
  }
  run = null;
  setExportState();
}

async function startRun() {
  if (running) return;
  if (!state.backend || (state.backend.kind !== 'litert' && state.backend.kind !== 'tasks')) {
    toast('Agent runs need the LiteRT-LM or tasks-genai runtime — mount a model first.', 'warning', 4200);
    return;
  }
  if (state.generating) {
    toast('Wait for the current chat reply to finish.', 'warning', 3000);
    return;
  }

  const config = readConfig();
  if (!config.task) {
    toast('Enter a task for the agent first.', 'warning', 3000);
    return;
  }
  persistForm();

  agentsControllerLog.innerHTML = '';
  agentsWorkerLog.innerHTML = '';
  agentsFinal.classList.add('hidden');
  agentsFinal.innerHTML = '';

  const declarations = await mcpManager.listDeclarations();
  if (!declarations.length) {
    toast('No MCP servers connected — the agent has no browser tools and can only talk.', 'warning', 4500);
  }
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (e) {
    toast('Could not load the AI SDK from the CDN: ' + e.message, 'error', 6000);
    return;
  }
  const { ToolLoopAgent, isStepCount, hasToolCall, generateText } = sdk;
  const { tools, toolDocs } = buildSdkTools(sdk, declarations);
  const instructions = buildInstructions(config, toolDocs);
  const isLitert = state.backend.kind === 'litert';
  const runtimeLabel = isLitert ? 'LiteRT-LM (AI SDK)' : 'tasks-genai (AI SDK)';
  const model = isLitert
    ? createLitertLanguageModel(state.backend, state.currentModel || 'litert-on-device')
    : createTasksLanguageModel(state.backend, state.currentModel || 'tasks-on-device');

  running = true;
  state.agentRunning = true;
  agentsBadge.classList.remove('hidden');
  run = {
    abort: new AbortController(),
    stats: { steps: 0, toolCalls: 0, cycles: 0 },
    events: [],
    screenshots: [],
    finalReport: null,
    finalCallId: null,
    verdicts: [],
    config,
    runtimeLabel,
    startedAt: Date.now(),
    timedOut: false,
    stoppedByUser: false,
    deadlineTimer: null,
    tickTimer: null
  };
  run.deadlineTimer = setTimeout(() => {
    if (!run) return;
    run.timedOut = true;
    run.abort.abort();
  }, config.maxMinutes * 60 * 1000);
  run.tickTimer = setInterval(renderStats, 1000);

  agentsStart.disabled = true;
  agentsStop.disabled = false;
  displayedRun = null;
  setExportState();
  setStatus(`Running · ${run.runtimeLabel}`, 'running');
  metaLog(agentsControllerLog, `task: ${config.task}`);
  metaLog(agentsControllerLog, `limits: ${config.maxSteps} steps · ${config.maxMinutes} min · tools: ${Object.keys(tools).length}`);
  recordEvent('task', { task: config.task });

  // ---- Supervisor loop: run the executor, judge the outcome, resume with
  // targeted feedback until validated, aborted, or out of budget. ----
  const agentStream = makeStreamTarget(agentsControllerLog);
  let messages = [{ role: 'user', content: config.task }];
  let answer = '';
  let stopReason = '';

  while (run && !run.abort.signal.aborted) {
    if (run.stats.steps >= config.maxSteps) {
      stopReason = `Step limit reached (${config.maxSteps} steps)`;
      break;
    }
    const remaining = Math.max(1, config.maxSteps - run.stats.steps);
    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
      stopWhen: [isStepCount(remaining), hasToolCall(FINAL_ANSWER_TOOL)],
      // Bound the model's context every step (the run keeps full history).
      prepareStep: ({ messages: stepMessages }) => {
        const compacted = compactMessages(stepMessages);
        if (compacted !== stepMessages) {
          metaLog(agentsControllerLog, `— context compacted (${stepMessages.length}→${compacted.length} msgs) —`);
          recordEvent('compact', { from: stepMessages.length, to: compacted.length });
        }
        return { messages: compacted };
      }
    });
    run.finalReport = null;
    run.finalCallId = null;
    try {
      debug('executor cycle start', { cycle: run.stats.cycles, remaining });
      const result = await agent.stream(
        run.stats.cycles === 0 && messages.length === 1
          ? { prompt: config.task, abortSignal: run.abort.signal }
          : { messages, abortSignal: run.abort.signal }
      );
      for await (const part of result.stream) {
        if (!run) return; // run was finished externally
        handleStreamPart(part, agentStream);
      }
      messages = messages.concat(await result.responseMessages);
    } catch (e) {
      if (!run) return;
      metaLog(agentsControllerLog, `⚠ ${e.message}`);
      recordEvent('error', { error: e.message });
      stopReason = `Error: ${truncate(e.message, 120)}`;
      break;
    }
    if (!run) return;
    if (run.abort.signal.aborted) break;

    // ---- Supervisor decision ----
    let feedback = null;
    if (run.finalReport) {
      const verdict = await supervisorCall('validator',
        `Task: ${config.task}\n\nEvidence (tool calls and their real results):\n${buildEvidenceDigest()}\n\nAgent's claimed final answer:\n${formatFinalReport(run.finalReport)}\n\nYour verdict:`,
        { answered: true, reason: '(validator inconclusive)', text: '' },
        generateText, model);
      if (!run) return;
      if (verdict === null) break; // aborted mid-validation
      if (verdict.answered) {
        answer = formatFinalReport(run.finalReport);
        stopReason = 'Agent submitted its final answer (validated)';
        break;
      }
      feedback = `The validator rejected your final answer: ${verdict.reason}. Keep working with the tools and call final_answer again only when the task is genuinely answered with real evidence.`;
      // The pending final_answer call has no execute, so it has no tool
      // result — close it out or the next step fails with
      // MissingToolResultsError. The rejection rides the tool channel.
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: run.finalCallId,
          toolName: FINAL_ANSWER_TOOL,
          output: { type: 'error-text', value: `Final answer rejected by the validator: ${verdict.reason}` }
        }]
      });
    } else if (model.lastTurnMalformed) {
      metaLog(agentsControllerLog, '⚠ malformed tool call — re-instructing the agent');
      recordEvent('malformed', {});
      feedback = 'Your last reply did not contain a valid tool call. Output exactly one line in this form: <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call> with valid JSON (every string in double quotes, arguments must be an object). Continue the task now.';
    } else if (recentToolErrorStreak()) {
      const plan = await supervisorCall('strategist',
        `Task: ${config.task}\n\nWhat happened so far:\n${buildEvidenceDigest()}\n\nAvailable tools:\n${toolDocs.map(formatToolDoc).join('\n')}\n\nGive a revised plan (at most 3 steps, exact tool names and arguments):`,
        '(continue the original task, avoiding the failing approach)',
        generateText, model);
      if (!run) return;
      if (plan === null) break;
      feedback = `Several tool calls failed. The strategist revised the plan — follow it:\n${plan}`;
    } else {
      // Plain early stop — did the transcript already answer the task?
      const verdict = await supervisorCall('validator',
        `Task: ${config.task}\n\nEvidence (tool calls and their real results):\n${buildEvidenceDigest()}\n\nThe agent stopped WITHOUT submitting a final answer. Judge whether the transcript already answers the task.\n\nYour verdict:`,
        { answered: false, reason: 'the agent stopped before finishing', text: '' },
        generateText, model);
      if (!run) return;
      if (verdict === null) break;
      if (verdict.answered) {
        answer = lastAgentText() || '(see transcript)';
        stopReason = 'Agent answered in prose (validated from transcript)';
        break;
      }
      feedback = `The task is not complete: ${verdict.reason}. Keep working with the tools; when done, call final_answer.`;
    }

    // Resume the executor with the supervisor's feedback, within budget.
    if (run.stats.cycles >= MAX_SUPERVISOR_CYCLES) {
      stopReason = `Supervisor cycle limit reached (${MAX_SUPERVISOR_CYCLES}) — finishing unverified`;
      if (run.finalReport) answer = formatFinalReport(run.finalReport);
      break;
    }
    run.stats.cycles++;
    recordEvent('resume', { cycle: run.stats.cycles, feedback: truncate(feedback, 300) });
    metaLog(agentsControllerLog, `↻ resuming (cycle ${run.stats.cycles} of ${MAX_SUPERVISOR_CYCLES})`);
    messages.push({ role: 'user', content: feedback });
    renderStats();
  }

  if (!run) return;
  if (!stopReason) {
    stopReason = run.stoppedByUser
      ? 'Stopped by user'
      : run.timedOut
        ? `Time limit reached (${config.maxMinutes} min)`
        : 'Agent stopped';
  }
  if (!answer && run.finalReport) answer = formatFinalReport(run.finalReport);
  await finishRun(stopReason, answer);
}

// ============================================================
// Saved runs — sidebar list, viewing, export
// ============================================================
let displayedRun = null;

function dispatchRunsChanged() {
  window.dispatchEvent(new CustomEvent('combs:agent-runs-changed'));
}

function setExportState() {
  agentsExport.disabled = !(running && run) && !displayedRun;
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
          setExportState();
        }
      });
    });
    container.appendChild(item);
  }
}

// New-format records replay their structured step events; legacy bus
// transcripts render into the same two panels (controller -> Agent,
// worker -> Tools, everything else as meta lines).
function loadRunRecord(r) {
  if (running) {
    toast('A run is in progress — stop it to view saved runs.', 'warning', 3000);
    return;
  }
  displayedRun = r;
  agentsControllerLog.innerHTML = '';
  agentsWorkerLog.innerHTML = '';

  if (Array.isArray(r.events)) {
    for (const ev of r.events) {
      if (ev.kind === 'task') metaLog(agentsControllerLog, `task: ${ev.task}`);
      else if (ev.kind === 'step') metaLog(agentsControllerLog, `— step ${ev.n} done (${ev.finishReason}) —`);
      else if (ev.kind === 'text') {
        const div = document.createElement('div');
        div.className = 'agents-msg';
        div.textContent = ev.text;
        agentsControllerLog.appendChild(div);
      }
      else if (ev.kind === 'validator') metaLog(agentsControllerLog, `⚖ validator: ${ev.verdict === 'answered' ? 'answered ✓' : `not answered — ${ev.reason}`}`);
      else if (ev.kind === 'strategist') {
        metaLog(agentsControllerLog, '🧭 strategist: revised plan');
        const div = document.createElement('div');
        div.className = 'agents-msg';
        div.textContent = ev.text;
        agentsControllerLog.appendChild(div);
      }
      else if (ev.kind === 'malformed') metaLog(agentsControllerLog, '⚠ malformed tool call — re-instructing the agent');
      else if (ev.kind === 'compact') metaLog(agentsControllerLog, `— context compacted (${ev.from}→${ev.to} msgs) —`);
      else if (ev.kind === 'resume') metaLog(agentsControllerLog, `↻ resumed (cycle ${ev.cycle}) — ${truncate(ev.feedback || '', 120)}`);
      else if (ev.kind === 'tool-call') metaLog(agentsWorkerLog, `🔧 ${ev.name}(${truncate(JSON.stringify(ev.input ?? {}), 160)})`);
      else if (ev.kind === 'tool-result') metaLog(agentsWorkerLog, `✓ ${ev.name}: ${ev.output}`);
      else if (ev.kind === 'tool-error') metaLog(agentsWorkerLog, `✗ ${ev.name}: ${ev.error}`);
      else if (ev.kind === 'error') metaLog(agentsControllerLog, `⚠ ${ev.error}`);
    }
  } else {
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
    for (const s of r.spectatorLog || []) {
      metaLog(agentsControllerLog, `[spectator:${s.agent}] ${truncate(s.text || '', 200)}`);
    }
  }

  const finalText = r.finalAnswer || formatFinalReport(r.finalReport);
  if (finalText) {
    agentsFinal.classList.remove('hidden');
    agentsFinal.innerHTML = `<div class="agents-final-title">Final answer</div><div>${escapeHtml(finalText)}</div>`;
  } else {
    agentsFinal.classList.add('hidden');
    agentsFinal.innerHTML = '';
  }
  setStatus(`Viewing saved run — ${r.stopReason}`);
  agentsStats.textContent = r.stats?.steps != null
    ? `steps:${r.stats.steps} · tools:${r.stats.toolCalls ?? 0} · cycles:${r.stats.cycles ?? r.supervisor?.cycles ?? 0}`
    : `turns C:${r.stats?.controllerTurns ?? '?'} · W:${r.stats?.workerTurns ?? '?'} · tools:${r.stats?.toolCalls ?? '?'}`;
  agentsElapsed.textContent = fmtElapsed((r.endedAt || r.startedAt) - r.startedAt);
  setExportState();
  dispatchRunsChanged(); // refresh sidebar so the loaded run shows as active
}

// ---- Export ----

function buildRunExport(rec) {
  const lines = [
    'COMBSLLM AGENT RUN EXPORT',
    '='.repeat(60),
    `Task: ${rec.task || ''}`,
    `Model: ${rec.model ? getModelName(rec.model) : '(unknown)'}`,
    `Runtime: ${rec.runtime || '(unknown)'}`,
    `Started: ${new Date(rec.startedAt).toISOString()}`,
    `Ended: ${rec.endedAt ? new Date(rec.endedAt).toISOString() : '(in progress)'}`,
    `Duration: ${fmtElapsed((rec.endedAt || Date.now()) - rec.startedAt)}`,
    `Stop reason: ${rec.stopReason || '(in progress)'}`
  ];
  lines.push(rec.stats?.steps != null
    ? `Stats: steps ${rec.stats.steps} · tool calls ${rec.stats.toolCalls ?? 0} · supervisor cycles ${rec.stats.cycles ?? rec.supervisor?.cycles ?? 0}`
    : `Stats: controller turns ${rec.stats?.controllerTurns ?? 0} · worker turns ${rec.stats?.workerTurns ?? 0} · tool calls ${rec.stats?.toolCalls ?? 0}`);
  const finalText = rec.finalAnswer || formatFinalReport(rec.finalReport);
  if (finalText) lines.push(`Final answer: ${finalText}`);
  lines.push('', 'TIMELINE (chronological)', '='.repeat(60));

  const stamp = (t) => `[${new Date(t).toISOString()}]`;
  if (Array.isArray(rec.events)) {
    for (const ev of rec.events) {
      if (ev.kind === 'task') lines.push('', `${stamp(ev.t)} TASK: ${ev.task}`);
      else if (ev.kind === 'step') lines.push('', `${stamp(ev.t)} STEP ${ev.n} DONE (${ev.finishReason})`);
      else if (ev.kind === 'text') lines.push(`${stamp(ev.t)} AGENT (step ${ev.step}):`, ev.text);
      else if (ev.kind === 'validator') lines.push(`${stamp(ev.t)} VALIDATOR: ${ev.verdict}${ev.reason && ev.reason !== '(no reason given)' ? ' — ' + ev.reason : ''}`, ev.text && ev.verdict !== 'answered' ? ev.text : '');
      else if (ev.kind === 'strategist') lines.push(`${stamp(ev.t)} STRATEGIST:`, ev.text);
      else if (ev.kind === 'malformed') lines.push(`${stamp(ev.t)} MALFORMED TOOL CALL — agent re-instructed`);
      else if (ev.kind === 'compact') lines.push(`${stamp(ev.t)} CONTEXT COMPACTED (${ev.from} -> ${ev.to} msgs)`);
      else if (ev.kind === 'resume') lines.push(`${stamp(ev.t)} RESUME (cycle ${ev.cycle}): ${ev.feedback || ''}`);
      else if (ev.kind === 'tool-call') lines.push('', `${stamp(ev.t)} TOOL CALL ${ev.name}:`, JSON.stringify(ev.input ?? {}));
      else if (ev.kind === 'tool-result') lines.push(`${stamp(ev.t)} TOOL RESULT ${ev.name}: ${ev.output}`);
      else if (ev.kind === 'tool-error') lines.push(`${stamp(ev.t)} TOOL ERROR ${ev.name}: ${ev.error}`);
      else if (ev.kind === 'error') lines.push(`${stamp(ev.t)} ERROR: ${ev.error}`);
    }
  } else {
    for (const e of rec.transcript || []) {
      const content = e.content ?? e.text ?? '';
      lines.push('', `${stamp(e.t)} ${(e.from || 'system').toUpperCase()}:`,
        Array.isArray(content) ? (content.find(p => p.alt)?.alt || '📷 image') : String(content));
    }
    for (const s of rec.spectatorLog || []) {
      lines.push('', `${stamp(s.t)} SPECTATOR ${(s.agent || '').toUpperCase()}:`, s.text || '');
    }
  }
  lines.push('');
  return lines.join('\n');
}

function currentRunRecord() {
  if (running && run) {
    return {
      task: run.config.task,
      model: state.currentModel || null,
      runtime: run.runtimeLabel,
      startedAt: run.startedAt,
      endedAt: null,
      stopReason: 'in progress',
      stats: run.stats,
      supervisor: { cycles: run.stats.cycles, verdicts: run.verdicts },
      finalReport: run.finalReport,
      events: run.events
    };
  }
  return displayedRun;
}

function exportRun() {
  const rec = currentRunRecord();
  if (!rec) {
    toast('Nothing to export yet — run the agent or open a saved run.', 'warning', 3000);
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
  // The settings (sliders) header button drives Prompts & limits here.
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
  agentsControllerPrompt.value = DEFAULT_AGENT_PROMPT;
  agentsMaxSteps.value = String(DEFAULT_MAX_STEPS);
  agentsMaxMinutes.value = String(DEFAULT_MAX_MINUTES);
  agentsBadge.classList.add('hidden');
  agentsControllerLog.innerHTML = '';
  agentsWorkerLog.innerHTML = '';
  agentsFinal.classList.add('hidden');
  agentsFinal.innerHTML = '';
  setStatus('Idle');
  agentsStats.textContent = 'steps:0 · tools:0 · cycles:0';
  agentsElapsed.textContent = '0:00';
  agentsStart.disabled = false;
  agentsStop.disabled = true;
  setExportState();
  agentsTask.focus();
}

export function initAgents() {
  // Restore the persisted form (prompt + limits) or fall back to defaults.
  agentsControllerPrompt.value = localStorage.getItem(FORM_KEYS.prompt) || DEFAULT_AGENT_PROMPT;
  agentsMaxSteps.value = localStorage.getItem(FORM_KEYS.maxSteps) || String(DEFAULT_MAX_STEPS);
  agentsMaxMinutes.value = localStorage.getItem(FORM_KEYS.maxMinutes) || String(DEFAULT_MAX_MINUTES);

  agentsBtn.addEventListener('click', () => {
    if (state.view === 'agents') exitAgentsView();
    else enterAgentsView();
    window.dispatchEvent(new CustomEvent('combs:view-changed'));
  });
  agentsStart.addEventListener('click', startRun);
  agentsStop.addEventListener('click', () => {
    if (!run) return;
    run.stoppedByUser = true;
    run.abort.abort();
  });
  agentsExport.addEventListener('click', exportRun);

  // Pods: origin-isolated runtimes (own storage quota + heap). The pod
  // page proves isolation and runs its own model; full ToolLoopAgent-in-
  // pod is a later increment (see atoms/pods header).
  agentsSpawnPod.addEventListener('click', async () => {
    try {
      const { openPod, listenToPod, sendModelBytes } = await import('../atoms/pods/index.js');
      // Hand the pod the currently-selected model's URL (it will try its
      // own cache → parent byte transfer → direct download, in that order).
      const def = state.currentModel ? getModelDef(state.currentModel) : null;
      const query = def && !def.remote
        ? `?${new URLSearchParams({ model: modelDownloadUrl(def) })}` : '';
      const { win, origin } = await openPod(`/flows/pod.html${query}`);
      listenToPod(win, origin, {
        onReady: () => toast(`pod live on ${origin}`, 'success', 4000),
        onModelRequest: (url) => sendModelBytes(win, origin, url),
      });
    } catch (e) {
      toast(e.message, 'error', 5000);
    }
  });
  setExportState();
}
