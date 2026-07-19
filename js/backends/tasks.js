// ============================================================
// tasks-genai backend (@mediapipe/tasks-genai).
// LlmInference keeps no conversation state, so each send replays the
// full message log as a manually templated prompt (see prompts.js).
// The SDK is loaded from jsDelivr at the version pinned by the model.
// ============================================================
import { TASKS_GENAI_STABLE, DEFAULT_MAX_TOKENS } from '../config.js';
import { buildPrompt } from '../prompts.js';

function loadTasksGenai(version) {
  return import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@${version}/+esm`);
}

function tasksGenaiWasmRoot(version) {
  return `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@${version}/wasm`;
}

export class TasksBackend {
  constructor(modelDef) {
    this.kind = 'tasks';
    this.sdk = modelDef.sdk || TASKS_GENAI_STABLE;
    this.promptFormat = modelDef.promptFormat || 'gemma4';
    this.llm = null;
  }

  // All options are create-time: changing them requires a remount.
  async mount(modelDef, modelUrl, { maxTokens = DEFAULT_MAX_TOKENS, vision = false, audio = false, maxNumImages = 0 } = {}) {
    const { FilesetResolver, LlmInference } = await loadTasksGenai(this.sdk);
    const genai = await FilesetResolver.forGenAiTasks(tasksGenaiWasmRoot(this.sdk));
    this.llm = await LlmInference.createFromOptions(genai, {
      baseOptions: { modelAssetPath: modelUrl },
      maxTokens,
      maxNumImages: vision ? maxNumImages : 0,
      supportAudio: !!audio
    });
  }

  // Stateless runtime — the log is the context, rebuilt on every send.
  async resetContext() {}

  async send(content, { history = [], caveman = false } = {}, onText) {
    const prompt = await buildPrompt(history, caveman, this.promptFormat);
    let streamed = '';
    const full = await this.llm.generateResponse(prompt, (partial) => {
      if (partial) {
        streamed += partial;
        onText(partial);
      }
    });
    return streamed || full || '';
  }

  async dispose() {
    if (this.llm) {
      this.llm.close();
      this.llm = null;
    }
  }
}
