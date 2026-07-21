// ============================================================
// LiteRT-LM backend (@litert-lm/core).
// The engine applies the model's built-in chat template and keeps
// conversation state; history is replayed via the preface on
// resetContext(). Image parts are sent as base64 blobs because
// messages cross the JS->WASM boundary as JSON.
// ============================================================
import { Engine, Backend } from 'https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm';
import { SYSTEM_PREFACE, DEFAULT_MAX_TOKENS } from '../config.js';
import { compressToCaveman } from '../text.js';
import { dataUrlToBase64 } from '../image.js';

// Safety cap for the agentic tool-calling loop.
const MAX_TOOL_ROUNDS = 5;

const STREAM_TIMEOUT = Symbol('stream-timeout');

// One generation round on any conversation: stream text, collect tool calls.
// With timeLimitMs > 0 the stream is hard-cancelled once the deadline passes
// (native cancel signal + reader cancel) and whatever text arrived so far is
// returned with timedOut: true.
async function streamConversationRound(conversation, payload, onText, timeLimitMs = 0) {
  const toolCalls = [];
  let text = '';
  let timedOut = false;
  const reader = conversation.sendMessageStreaming(payload).getReader();
  const deadline = timeLimitMs > 0 ? Date.now() + timeLimitMs : Infinity;
  try {
    while (true) {
      let step;
      if (deadline === Infinity) {
        step = await reader.read();
      } else {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { timedOut = true; break; }
        step = await Promise.race([
          reader.read(),
          new Promise(resolve => setTimeout(() => resolve(STREAM_TIMEOUT), remaining))
        ]);
        if (step === STREAM_TIMEOUT) { timedOut = true; break; }
      }
      if (step.done) break;
      const chunk = step.value;
      if (Array.isArray(chunk.tool_calls)) toolCalls.push(...chunk.tool_calls);
      const content = chunk.content ?? [];
      if (typeof content === 'string') {
        text += content;
        onText(content);
      } else {
        for (const item of content) {
          if (item.type === 'text') {
            text += item.text;
            onText(item.text);
          }
        }
      }
    }
  } finally {
    if (timedOut) {
      try { conversation.cancel(); } catch { /* best effort */ }
      try { await reader.cancel(); } catch { /* best effort */ }
    }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { text, toolCalls, timedOut };
}

// Shared agentic turn: generate -> execute requested tool calls via the
// provider -> feed results back -> repeat until plain text (or round cap).
// Used by both the chat backend and the agent orchestrator.
export async function runAgentTurn(conversation, payload, { toolProvider = null, onText = () => {}, onToolCall = () => {}, onBeforeToolCall = () => {}, onAfterToolCall = () => {}, maxToolRounds = MAX_TOOL_ROUNDS, timeLimitMs = 0, onTimeout = () => {} } = {}) {
  console.log('[LITERT runAgentTurn] start', { payload: typeof payload === 'string' ? payload.slice(0, 200) : payload, hasToolProvider: !!toolProvider, timeLimitMs });
  let fullText = '';
  let current = payload;
  for (let round = 0; round < maxToolRounds; round++) {
    const t0 = performance.now();
    const { text, toolCalls, timedOut } = await streamConversationRound(conversation, current, onText, timeLimitMs);
    console.log(`[LITERT runAgentTurn] round ${round}`, { durationMs: Math.round(performance.now() - t0), text: text.slice(0, 300), toolCalls: toolCalls.map(c => c.function), timedOut });
    fullText += text;
    // Hard stream cap hit — return the partial reply without executing any
    // tool calls that may have been cut in half.
    if (timedOut) {
      onTimeout();
      return fullText;
    }
    if (!toolCalls.length) {
      console.log('[LITERT runAgentTurn] no tool calls, returning');
      return fullText;
    }

    const toolParts = [];
    for (const call of toolCalls) {
      const fn = call.function || {};
      await onBeforeToolCall(call);
      let resultText;
      try {
        resultText = toolProvider
          ? await toolProvider.callTool(fn.name, fn.arguments || {})
          : 'Error: no tool provider configured';
      } catch (e) {
        resultText = `Error: ${e.message}`;
      }
      console.log('[LITERT runAgentTurn] tool result', { name: fn.name, args: fn.arguments, resultText: resultText.slice(0, 300) });
      toolParts.push({ type: 'tool_response', name: fn.name, response: resultText });
      onToolCall(call, resultText);
      await onAfterToolCall(call, resultText);
    }
    current = { role: 'tool', content: toolParts };
  }
  console.log('[LITERT runAgentTurn] round cap reached');
  return fullText;
}

export class LitertBackend {
  constructor() {
    this.kind = 'litert';
    this.engine = null;
    this.conversation = null;
    this.modalities = { vision: false, audio: false };
    this.toolProvider = null;
  }

  // Tool provider (e.g. the MCP manager) exposing listDeclarations/callTool.
  // Tools are bound at conversation level, so changes apply on resetContext().
  setToolProvider(provider) {
    this.toolProvider = provider;
  }

  async mount(modelDef, modelUrl, { maxTokens = DEFAULT_MAX_TOKENS, vision = false, audio = false, forceCpu = false } = {}) {
    this.modalities = { vision, audio };
    const settings = { model: modelUrl, mainExecutorSettings: { maxNumTokens: maxTokens } };
    if (forceCpu) settings.backend = Backend.CPU;
    this.engine = await Engine.create(settings);
  }

  // Modality flags are session-scoped: they can change after mount and take
  // effect on the next resetContext(), without remounting the engine.
  updateModalities({ vision, audio }) {
    this.modalities = { vision, audio };
  }

  sessionConfig() {
    return {
      visionModalityEnabled: this.modalities.vision,
      audioModalityEnabled: this.modalities.audio
    };
  }

  // Rebuild the engine-side conversation from the logged messages.
  async resetContext(messages, { caveman = false } = {}) {
    if (this.conversation) await this.conversation.delete();
    const withSystem = messages.some(m => m.role === 'system')
      ? messages
      : [{ role: 'system', content: SYSTEM_PREFACE }, ...messages];
    const engineMessages = [];
    for (const msg of withSystem) {
      engineMessages.push({
        role: msg.role,
        content: msg.role === 'system' ? msg.content : await this.toEngineContent(msg.content, caveman)
      });
    }
    const preface = { messages: engineMessages };
    const tools = this.toolProvider ? await this.toolProvider.listDeclarations() : [];
    if (tools.length) preface.tools = tools;
    this.conversation = await this.engine.createConversation({
      sessionConfig: this.sessionConfig(),
      preface
    });
  }

  async toEngineContent(content, caveman) {
    if (typeof content === 'string') return caveman ? compressToCaveman(content) : content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const part of content) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: caveman ? compressToCaveman(part.text) : part.text });
        } else if (part.type === 'image' && part.dataUrl) {
          parts.push({ type: 'image', blob: dataUrlToBase64(part.dataUrl) });
        } else if (part.type === 'audio' && part.dataUrl) {
          parts.push({ type: 'audio', blob: dataUrlToBase64(part.dataUrl) });
        }
      }
      return parts;
    }
    return content;
  }

  // One generation round: stream text chunks, collect any tool calls.
  async streamRound(payload, onText) {
    return streamConversationRound(this.conversation, payload, onText);
  }

  // Agentic loop: generate -> if the model requested tool calls, execute
  // them via the provider, feed results back as a tool message, repeat
  // until the model answers with plain text (or the round cap hits).
  async send(content, { caveman = false } = {}, onText) {
    let payload = await this.toEngineContent(content, caveman);
    let fullText = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { text, toolCalls } = await this.streamRound(payload, onText);
      fullText += text;
      if (!toolCalls.length) return fullText;

      const toolParts = [];
      for (const call of toolCalls) {
        const fn = call.function || {};
        const argsPreview = JSON.stringify(fn.arguments || {});
        const startMarker = `\n\n*🔧 Calling \`${fn.name}\`(${argsPreview.length > 100 ? argsPreview.slice(0, 100) + '…' : argsPreview})*`;
        fullText += startMarker;
        onText(startMarker);
        const t0 = performance.now();
        let resultText;
        let failed = false;
        try {
          resultText = await this.toolProvider.callTool(fn.name, fn.arguments || {});
        } catch (e) {
          resultText = `Error: ${e.message}`;
          failed = true;
        }
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        const doneMarker = failed
          ? `\n*✗ failed after ${secs}s*`
          : `\n*✓ result received in ${secs}s*`;
        fullText += doneMarker;
        onText(doneMarker);
        toolParts.push({ type: 'tool_response', name: fn.name, response: resultText });
      }
      fullText += '\n\n';
      onText('\n\n');
      payload = { role: 'tool', content: toolParts };
    }
    return fullText;
  }

  async dispose() {
    try {
      if (this.conversation) await this.conversation.delete();
      if (this.engine) await this.engine.delete();
    } finally {
      this.conversation = null;
      this.engine = null;
    }
  }
}
