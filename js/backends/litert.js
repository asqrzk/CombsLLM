// ============================================================
// LiteRT-LM backend (@litert-lm/core).
// The engine applies the model's built-in chat template and keeps
// conversation state; history is replayed via the preface on
// resetContext(). Image parts are sent as base64 blobs because
// messages cross the JS->WASM boundary as JSON.
// ============================================================
import { Engine } from 'https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm';
import { SYSTEM_PREFACE, DEFAULT_MAX_TOKENS } from '../config.js';
import { compressToCaveman } from '../text.js';
import { dataUrlToBase64 } from '../image.js';

export class LitertBackend {
  constructor() {
    this.kind = 'litert';
    this.engine = null;
    this.conversation = null;
    this.modalities = { vision: false, audio: false };
  }

  async mount(modelDef, modelUrl, { maxTokens = DEFAULT_MAX_TOKENS, vision = false, audio = false } = {}) {
    this.modalities = { vision, audio };
    this.engine = await Engine.create({
      model: modelUrl,
      mainExecutorSettings: { maxNumTokens: maxTokens }
    });
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
    this.conversation = await this.engine.createConversation({
      sessionConfig: this.sessionConfig(),
      preface: { messages: engineMessages }
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

  async send(content, { caveman = false } = {}, onText) {
    const payload = await this.toEngineContent(content, caveman);
    let text = '';
    const stream = this.conversation.sendMessageStreaming(payload);
    for await (const chunk of stream) {
      for (const item of chunk.content) {
        if (item.type === 'text') {
          text += item.text;
          onText(item.text);
        }
      }
    }
    return text;
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
