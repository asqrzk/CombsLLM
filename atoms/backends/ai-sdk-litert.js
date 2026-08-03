// ============================================================
// AI SDK LanguageModel (specificationVersion 'v3') over the LiteRT-LM
// backend. Lets the Vercel AI SDK (ToolLoopAgent, streamText, ...) drive
// the on-device engine: SDK prompts are mapped onto a fresh LiteRT
// Conversation per call (history via the preface, the final message as
// the payload), and LiteRT stream chunks are adapted to SDK stream parts.
//
// Correctness-first: every call replays the full message history into a
// new conversation (the engine's KV cache is not reused across calls).
// ============================================================

function uint8ToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// SDK file-part data (Uint8Array | base64 string | URL/data URL) -> base64.
function fileDataToBase64(data) {
  if (typeof data === 'string') {
    const m = data.match(/^data:[^;,]+;base64,(.*)$/s);
    return m ? m[1] : data; // already base64 per the SDK spec
  }
  if (data instanceof Uint8Array) return uint8ToBase64(data);
  if (data instanceof URL && data.protocol === 'data:') return fileDataToBase64(data.href);
  return null;
}

// One SDK prompt message -> LiteRT engine messages (array; empty = skip).
// A tool message can expand to two engine messages: the native tool
// response, plus a user message carrying any returned images (screenshots)
// — the engine only accepts image parts on user messages.
function toEngineMessages(msg, { vision }) {
  if (msg.role === 'system') {
    return [{ role: 'system', content: typeof msg.content === 'string' ? msg.content : '' }];
  }
  if (msg.role === 'user') {
    const parts = [];
    for (const part of msg.content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'file' && vision && (part.mediaType || '').startsWith('image/')) {
        const blob = fileDataToBase64(part.data);
        if (blob) parts.push({ type: 'image', blob });
      }
    }
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (!parts.length) return [{ role: 'user', content: '' }];
    if (parts.every(p => p.type === 'text')) return [{ role: 'user', content: text }];
    return [{ role: 'user', content: parts }];
  }
  if (msg.role === 'assistant') {
    const text = [];
    const toolCalls = [];
    for (const part of msg.content) {
      if (part.type === 'text') text.push(part.text);
      else if (part.type === 'tool-call') {
        toolCalls.push({
          type: 'function',
          id: part.toolCallId,
          function: { name: part.toolName, arguments: part.input ?? {} }
        });
      }
    }
    const out = { role: 'assistant', content: text.join('\n') };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return [out];
  }
  if (msg.role === 'tool') {
    const parts = [];
    const images = [];
    for (const part of msg.content) {
      if (part.type !== 'tool-result') continue;
      parts.push({ type: 'tool_response', name: part.toolName, response: toolOutputToText(part.output) });
      if (vision) images.push(...toolOutputToImageParts(part.output));
    }
    const out = [{ role: 'tool', content: parts }];
    if (images.length) {
      out.push({ role: 'user', content: [...images, { type: 'text', text: '(image returned by the tool above)' }] });
    }
    return out;
  }
  return [];
}

// SDK ToolResultOutput -> a string the engine's chat template can render.
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
        .map(v => v.type === 'text' ? v.text : `[${v.type}]`)
        .join('\n');
    default:
      return String(output.value ?? '');
  }
}

// Images returned by tools (screenshots) ride the tool payload as real image
// parts so a vision-enabled model can actually see them.
function toolOutputToImageParts(output) {
  if (!output || output.type !== 'content') return [];
  const parts = [];
  for (const v of output.value || []) {
    if (v.type === 'image-data') {
      const blob = fileDataToBase64(v.data);
      if (blob) parts.push({ type: 'image', blob });
    } else if (v.type === 'file' && (v.mediaType || '').startsWith('image/')) {
      // v7 shape: { type: 'file', data: { type: 'data', data }, mediaType }
      const d = v.data;
      const raw = d && typeof d === 'object' && !(d instanceof Uint8Array) && d.type === 'data' ? d.data : d;
      const blob = fileDataToBase64(raw);
      if (blob) parts.push({ type: 'image', blob });
    }
  }
  return parts;
}

const EMPTY_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined }
};

let nextToolCallId = 1;

// A LanguageModelV3 instance bound to a mounted LitertBackend.
export function createLitertLanguageModel(backend, modelId = 'litert-on-device') {
  const vision = () => !!backend.modalities?.vision;

  // ---- KV-cache fast path ----
  // SDK prompts are append-only within an executor cycle, so instead of
  // replaying the whole history into a fresh conversation per step, we keep
  // one conversation alive and only send the genuinely new payload. The
  // engine's KV cache already holds everything else. Any deviation
  // (compaction, injected feedback, tool changes) triggers a full rebuild.
  let kvConversation = null;
  let kvSnapshot = [];       // engine messages known to be in the conversation
  let kvToolsJson = '[]';

  async function invalidateKv() {
    if (!kvConversation) return;
    try { await kvConversation.delete(); } catch { /* already gone */ }
    kvConversation = null;
    kvSnapshot = [];
    kvToolsJson = '[]';
  }

  // Build (history, payload) from an SDK prompt and run one streaming round,
  // invoking callbacks as chunks arrive. Returns { toolCalls }.
  async function runRound(options, { onTextDelta, onToolCall, textId }) {
    const messages = options.prompt.flatMap(m => toEngineMessages(m, { vision: vision() }));
    const payloadMsg = messages.pop() || { role: 'user', content: '' };
    // A tool payload keeps the native tool channel; anything else (e.g. the
    // image carrier above) goes as a regular user payload.
    const payload = payloadMsg.role === 'tool'
      ? { role: 'tool', content: payloadMsg.content }
      : { role: 'user', content: payloadMsg.content };
    const sdkTools = (options.tools || []).filter(t => t.type === 'function');
    const prefaceTools = sdkTools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } }
    }));
    const toolsJson = JSON.stringify(prefaceTools);

    // Fast path is valid when the new history extends the snapshot by only
    // engine-generated assistant turns (already in the KV cache).
    const prefixMatch = kvConversation
      && kvToolsJson === toolsJson
      && messages.length >= kvSnapshot.length
      && kvSnapshot.every((m, i) => JSON.stringify(m) === JSON.stringify(messages[i]));
    const fastPath = prefixMatch
      && messages.slice(kvSnapshot.length).every(m => m.role === 'assistant');

    let conversation;
    if (fastPath) {
      conversation = kvConversation;
    } else {
      await invalidateKv();
      const preface = { messages };
      if (prefaceTools.length) preface.tools = prefaceTools;
      conversation = await backend.engine.createConversation({
        sessionConfig: backend.sessionConfig(),
        preface
      });
    }

    const toolCalls = [];
    const abortSignal = options.abortSignal;
    let failed = false;
    try {
      const reader = conversation.sendMessageStreaming(payload).getReader();
      const onAbort = () => {
        try { conversation.cancel(); } catch { /* best effort */ }
        try { reader.cancel(); } catch { /* best effort */ }
      };
      if (abortSignal) {
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (abortSignal?.aborted) break;
          if (Array.isArray(chunk.tool_calls)) {
            for (const call of chunk.tool_calls) {
              const fn = call.function || {};
              const toolCall = {
                toolCallId: call.id || `call_${nextToolCallId++}`,
                toolName: fn.name,
                input: JSON.stringify(fn.arguments ?? {})
              };
              toolCalls.push(toolCall);
              onToolCall(toolCall);
            }
          }
          const content = chunk.content ?? [];
          const texts = typeof content === 'string'
            ? [content]
            : content.filter(i => i.type === 'text').map(i => i.text);
          for (const t of texts) onTextDelta(textId, t);
        }
      } finally {
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    } catch (e) {
      failed = true;
      await invalidateKv(); // KV state unknown after an error — rebuild next time
      throw e;
    }
    const aborted = !!abortSignal?.aborted;
    if (aborted) {
      await invalidateKv(); // partial generation may be in the cache
    } else {
      kvConversation = conversation;
      kvSnapshot = [...messages, payloadMsg];
      kvToolsJson = toolsJson;
    }
    return { toolCalls, aborted, failed };
  }

  return {
    specificationVersion: 'v3',
    provider: 'combsllm-litert',
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const content = [];
      let text = '';
      const textId = 'text-1';
      const { toolCalls, aborted } = await runRound(options, {
        textId,
        onTextDelta: (_id, delta) => { text += delta; },
        onToolCall: (tc) => content.push({ type: 'tool-call', ...tc })
      });
      if (text) content.unshift({ type: 'text', text });
      return {
        content,
        finishReason: { unified: aborted ? 'other' : (toolCalls.length ? 'tool-calls' : 'stop'), raw: undefined },
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
            const result = await runRound(options, {
              textId,
              onTextDelta: (id, delta) => enqueue({ type: 'text-delta', id, delta }),
              onToolCall: (tc) => { sawToolCall = true; enqueue({ type: 'tool-call', ...tc }); }
            });
            aborted = result.aborted;
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
}
