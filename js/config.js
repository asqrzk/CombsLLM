// ============================================================
// Static configuration: model registry, limits, constants.
// ============================================================

export const SYSTEM_PREFACE = 'You are a hardware-constrained AI assistant. Respond accurately.';

export const ENGINE_MAX_TOKENS = 8192;

// tasks-genai runtime used by every tasks backend model.
export const TASKS_GENAI_STABLE = '0.10.29';

// Image intake policy.
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_DIM = 1024; // longest side in px
export const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp']);

// IndexedDB chat store.
export const DB_NAME = 'combsllm-chats';
export const DB_STORE = 'chats';

// Model registry. Each entry is a fixed artifact + fixed runtime:
//   backend: 'litert' -> @litert-lm/core (Engine + Conversation, chat template built in)
//            'tasks'  -> @mediapipe/tasks-genai (LlmInference, prompt built manually)
//   promptFormat: which manual template the tasks backend should emit
//   tags: advertised capabilities of the artifact ('text' | 'vision' | 'audio').
//         Informational only — unsupported combinations fail at runtime.
export const MODELS = {
  'gemma-4-E2B-it-web': {
    label: 'Gemma 4 E2B',
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    file: 'gemma-4-E2B-it-web.litertlm',
    backend: 'litert',
    promptFormat: 'gemma4',
    tags: ['text']
  },
  'gemma-4-E4B-it-web': {
    label: 'Gemma 4 E4B',
    repo: 'litert-community/gemma-4-E4B-it-litert-lm',
    file: 'gemma-4-E4B-it-web.litertlm',
    backend: 'litert',
    promptFormat: 'gemma4',
    tags: ['text']
  },
  'gemma-4-E2B-it-web-task': {
    label: 'Gemma 4 E2B',
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    file: 'gemma-4-E2B-it-web.task',
    backend: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma4',
    tags: ['text', 'vision']
  },
  'gemma-4-E4B-it-web-task': {
    label: 'Gemma 4 E4B',
    repo: 'litert-community/gemma-4-E4B-it-litert-lm',
    file: 'gemma-4-E4B-it-web.task',
    backend: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma4',
    tags: ['text', 'vision']
  },
  'gemma-3n-E2B-it-web': {
    label: 'Gemma-3n E2B',
    repo: 'google/gemma-3n-E2B-it-litert-lm',
    file: 'gemma-3n-E2B-it-int4-Web.litertlm',
    backend: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma3',
    tags: ['text', 'vision', 'audio']
  },
  'gemma-3n-E4B-it-web': {
    label: 'Gemma-3n E4B',
    repo: 'google/gemma-3n-E4B-it-litert-lm',
    file: 'gemma-3n-E4B-it-int4-Web.litertlm',
    backend: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma3',
    tags: ['text', 'vision', 'audio']
  }
};

export function getModelDef(modelId) {
  return MODELS[modelId] || null;
}

export function getModelName(modelId) {
  return MODELS[modelId]?.label || modelId;
}

export function modelDownloadUrl(modelDef) {
  return `https://huggingface.co/${modelDef.repo}/resolve/main/${modelDef.file}`;
}
