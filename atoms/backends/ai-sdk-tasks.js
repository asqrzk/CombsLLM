// ============================================================
// AI SDK LanguageModel (specificationVersion 'v3') over the tasks-genai
// (MediaPipe) backend. That runtime has no native tool channel, so this
// provider is the "last mile" harness: tool schemas are injected into the
// prompt as text, the model emits <tool_call>{...}</tool_call> markers,
// and parsed calls are surfaced to the SDK as real tool-call parts. The
// SDK (ToolLoopAgent) owns the loop, history, stop conditions and the
// structured final answer — the text protocol never leaves this file.
// ============================================================
import { buildPrompt } from '../prompts.js';

// ---- Tool-call text protocol (parsed out of free-text output) ----

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

// Extract tool calls from generated text. Returns { calls, text } where
// text has all <tool_call> regions removed.
function parseToolCalls(text, toolNames) {
  const calls = [];
  const seen = new Set();
  const add = (raw) => {
    const call = tryParseToolCall(raw, toolNames);
    if (!call) return;
    const key = JSON.stringify(call);
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(call);
  };

  // 1. Explicit <tool_call>...</tool_call> markers. Slice the outermost
  // braces — a non-greedy brace match stops at the inner close.
  const markerRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m;
  while ((m = markerRe.exec(text))) {
    const inner = m[1].trim();
    const start = inner.indexOf('{');
    const end = inner.lastIndexOf('}');
    if (start !== -1 && end > start) add(inner.slice(start, end + 1));
  }

  // 2. Fenced code blocks (```json, ```tool_call, or any other language tag).
  const codeRe = /```\w*\s*(\{[\s\S]*?\})\s*```/g;
  while ((m = codeRe.exec(text))) add(m[1]);

  // 3. Standalone JSON lines that mention a known tool name.
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) add(trimmed);
  }

  return { calls, text: text.replace(markerRe, '').trim() };
}

// Marker-like tool-call content that failed to parse (fenced blocks, broken
// JSON, unknown tool names). Used by the supervisor to tell "the model
// stopped" apart from "the model tried to call a tool but garbled it".
function hasMalformedToolCall(text, calls) {
  if (calls.length > 0) return false;
  return /<tool_call|```\w*\s*\{[^}]*"name"\s*:/.test(text);
}

// ---- Prompt-side rendering ----

function formatToolDoc(t) {
  const params = t.inputSchema || {};
  const props = params.properties || {};
  const required = new Set(params.required || []);
  const args = Object.entries(props).map(([name, schema]) => {
    const req = required.has(name) ? 'required' : 'optional';
    return `${name} (${req}, ${schema.type || 'any'})`;
  }).join(', ') || 'none';
  return `- ${t.name}: ${t.description || t.name} | args: { ${args} }`;
}

// Tool documentation + call syntax injected into the system turn. Prefer a
// navigate-style example — a launch_browser example primes small models to
// answer every instruction by re-launching the browser.
function buildToolSection(sdkTools) {
  const docs = sdkTools.map(formatToolDoc).join('\n');
  const example = sdkTools.find(t => /navigate/i.test(t.name))
    || sdkTools.find(t => /screenshot/i.test(t.name))
    || sdkTools[0];
  const exampleArgs = /navigate/i.test(example.name) ? '{"url":"https://duckduckgo.com"}' : '{}';
  return [
    '',
    'Available tools:',
    docs,
    '',
    'To call a tool, output ONLY a line like:',
    `<tool_call>{"name":"${example.name}","arguments":${exampleArgs}}</tool_call>`,
    'Replace the name and arguments with the real tool you need. After each tool call you will receive its result as a [tool_result] message. Never invent tool results.'
  ].join('\n');
}

function uint8ToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// SDK file-part data -> data URL (what prompts.js media parts expect).
function fileDataToDataUrl(data, mediaType) {
  if (typeof data === 'string') {
    return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`;
  }
  if (data instanceof Uint8Array) return `data:${mediaType};base64,${uint8ToBase64(data)}`;
  if (data instanceof URL && data.protocol === 'data:') return data.href;
  return null;
}

function toolOutputToText(output) {
  if (!output) return '';
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return typeof output.value === 'string' ? output.value : JSON.stringify(output.value);
    case 'content':
      return (output.value || [])
        .map(v => v.type === 'text' ? v.text : `[${v.type === 'file' ? 'image' : v.type}]`)
        .join('\n');
    default:
      return String(output.value ?? '');
  }
}

function toolOutputToImages(output, vision) {
  if (!vision || !output || output.type !== 'content') return [];
  const images = [];
  for (const v of output.value || []) {
    if (v.type === 'file' && (v.mediaType || '').startsWith('image/')) {
      const d = v.data;
      const raw = d && typeof d === 'object' && !(d instanceof Uint8Array) && d.type === 'data' ? d.data : d;
      const dataUrl = fileDataToDataUrl(raw, v.mediaType);
      if (dataUrl) images.push({ type: 'image', dataUrl });
    }
  }
  return images;
}

// SDK prompt -> the message log shape buildPrompt expects.
function toLogMessages(prompt, sdkTools, { vision, maxImages }) {
  const log = [];
  for (const msg of prompt) {
    if (msg.role === 'system') {
      let text = typeof msg.content === 'string' ? msg.content : '';
      if (sdkTools.length) text += buildToolSection(sdkTools);
      log.push({ role: 'system', content: text });
    } else if (msg.role === 'user') {
      const parts = [];
      for (const part of msg.content) {
        if (part.type === 'text') parts.push({ type: 'text', text: part.text });
        else if (part.type === 'file' && (part.mediaType || '').startsWith('image/')) {
          const dataUrl = fileDataToDataUrl(part.data, part.mediaType);
          if (vision && dataUrl) parts.push({ type: 'image', dataUrl });
        }
      }
      const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
      log.push({ role: 'user', content: parts.some(p => p.type === 'image') ? parts : text });
    } else if (msg.role === 'assistant') {
      // Render prior tool calls back as marker lines, exactly as the model
      // first emitted them — keeps the text protocol consistent across steps.
      let text = '';
      for (const part of msg.content) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'tool-call') {
          text += `\n<tool_call>${JSON.stringify({ name: part.toolName, arguments: part.input ?? {} })}</tool_call>`;
        }
      }
      log.push({ role: 'assistant', content: text.trim() });
    } else if (msg.role === 'tool') {
      // Gemma has no tool role — results come back as a user turn.
      const lines = [];
      const images = [];
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue;
        lines.push(`[tool_result] ${part.toolName}: ${toolOutputToText(part.output)}`);
        images.push(...toolOutputToImages(part.output, vision));
      }
      log.push({ role: 'user', content: images.length ? [{ type: 'text', text: lines.join('\n') }, ...images] : lines.join('\n') });
    }
  }
  if (!log.some(m => m.role === 'system') && sdkTools.length) {
    log.unshift({ role: 'system', content: buildToolSection(sdkTools).trim() });
  }
  // Image backstop: never send more images than the engine was mounted
  // with (exceeding maxNumImages crashes the runtime). Newest wins.
  let seen = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i];
    if (!Array.isArray(m.content)) continue;
    const kept = [];
    for (const part of m.content) {
      if (part.type === 'image') {
        seen++;
        if (seen > maxImages) {
          kept.unshift({ type: 'text', text: '[earlier image omitted]' });
          continue;
        }
      }
      kept.unshift(part);
    }
    m.content = kept;
  }
  return log;
}

const EMPTY_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined }
};

const MARKER = '<tool_call>';
let nextToolCallId = 1;

// A LanguageModelV3 instance bound to a mounted TasksBackend.
export function createTasksLanguageModel(backend, modelId = 'tasks-on-device') {
  const vision = () => !!backend.vision;

  // One generation: build the prompt, stream text (holding back anything
  // from a <tool_call> marker onward), parse tool calls at the end.
  async function runGeneration(options, { onTextDelta }) {
    const sdkTools = (options.tools || []).filter(t => t.type === 'function');
    const toolNames = new Set(sdkTools.map(t => t.name));
    const log = toLogMessages(options.prompt, sdkTools, {
      vision: vision(),
      maxImages: vision() ? (backend.maxNumImages || 1) : 0
    });
    const promptParts = await buildPrompt(log, false, backend.promptFormat);

    const abortSignal = options.abortSignal;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { backend.llm.cancelProcessing(); } catch { /* best effort */ }
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let full = '';
    let held = '';
    let suppressing = false;
    const KEEP = MARKER.length + 1; // hold back a tail so split markers are caught
    const onPartial = (partial) => {
      if (!partial || aborted) return;
      full += partial;
      if (suppressing) return;
      held += partial;
      const idx = held.indexOf(MARKER);
      if (idx !== -1) {
        const before = held.slice(0, idx);
        if (before) onTextDelta(before);
        held = '';
        suppressing = true;
        return;
      }
      if (held.length > KEEP) {
        onTextDelta(held.slice(0, held.length - KEEP));
        held = held.slice(-KEEP);
      }
    };

    try {
      // Serialized against the single LlmInference (see tasks.js). The
      // QUEUE SLOT tracks the raw generateResponse promise — a slow zombie
      // (never settles after cancelProcessing) delays later calls instead
      // of throwing "Previous invocation or loading is still ongoing".
      // The CALLER races that slot against the abort signal so an aborted
      // run unwinds immediately; the late zombie outcome is swallowed.
      const call = backend.enqueueLlm(() => backend.llm.generateResponse(promptParts, onPartial));
      const abortRace = new Promise((_, reject) => {
        if (abortSignal) {
          if (abortSignal.aborted) reject(new Error('aborted'));
          else abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }
      });
      try {
        await Promise.race([call, abortRace]);
      } catch (raceErr) {
        if (aborted) call.catch(() => {}); // late zombie outcome — swallow
        throw raceErr;
      }
    } catch (e) {
      if (!aborted && e.message !== 'aborted') throw e;
    } finally {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (aborted) {
        // Reset the cancel signal so the next generation starts clean.
        try { backend.llm.clearCancelSignals(); } catch { /* best effort */ }
      }
    }
    if (!suppressing && held) onTextDelta(held);

    const { calls, text } = parseToolCalls(full, toolNames);
    return { calls, text, aborted, malformed: hasMalformedToolCall(full, calls) };
  }

  const modelApi = {
    specificationVersion: 'v3',
    provider: 'combsllm-tasks',
    modelId,
    supportedUrls: {},
    // Set after every call: true when the model emitted marker-like tool-call
    // text that could not be parsed (the loop then stopped on 'stop').
    lastTurnMalformed: false,

    async doGenerate(options) {
      let streamedText = '';
      const { calls, text, aborted, malformed } = await runGeneration(options, {
        onTextDelta: (d) => { streamedText += d; }
      });
      modelApi.lastTurnMalformed = malformed;
      // Prefer the marker-stripped full text (catches unparsed regions the
      // streamer suppressed); fall back to what was streamed.
      const finalText = (text || streamedText).trim();
      const content = [];
      if (finalText) content.push({ type: 'text', text: finalText });
      for (const call of calls) {
        content.push({
          type: 'tool-call',
          toolCallId: `call_${nextToolCallId++}`,
          toolName: call.name,
          input: JSON.stringify(call.arguments ?? {})
        });
      }
      return {
        content,
        finishReason: { unified: aborted ? 'other' : (calls.length ? 'tool-calls' : 'stop'), raw: undefined },
        usage: EMPTY_USAGE,
        warnings: []
      };
    },

    async doStream(options) {
      const textId = 'text-1';
      const stream = new ReadableStream({
        async start(controller) {
          const enqueue = (part) => {
            try { controller.enqueue(part); } catch { /* stream already closed */ }
          };
          enqueue({ type: 'stream-start', warnings: [] });
          enqueue({ type: 'text-start', id: textId });
          let sawToolCall = false;
          let aborted = false;
          try {
            const result = await runGeneration(options, {
              onTextDelta: (d) => enqueue({ type: 'text-delta', id: textId, delta: d })
            });
            aborted = result.aborted;
            modelApi.lastTurnMalformed = result.malformed;
            for (const call of result.calls) {
              sawToolCall = true;
              enqueue({
                type: 'tool-call',
                toolCallId: `call_${nextToolCallId++}`,
                toolName: call.name,
                input: JSON.stringify(call.arguments ?? {})
              });
            }
          } catch (error) {
            enqueue({ type: 'error', error });
          }
          enqueue({ type: 'text-end', id: textId });
          enqueue({
            type: 'finish',
            finishReason: { unified: aborted ? 'other' : (sawToolCall ? 'tool-calls' : 'stop'), raw: undefined },
            usage: EMPTY_USAGE
          });
          try { controller.close(); } catch { /* already closed */ }
        }
      });
      return { stream };
    }
  };
  return modelApi;
}
