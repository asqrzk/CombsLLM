// ============================================================
// Static configuration: model registry, limits, constants.
// ============================================================

export const SYSTEM_PREFACE = 'You are a hardware-constrained AI assistant. Respond accurately.';

export const DEFAULT_MAX_TOKENS = 8192;

// tasks-genai runtime used by every tasks backend model.
export const TASKS_GENAI_STABLE = '0.10.29';

// Image intake policy.
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_DIM = 1024; // longest side in px
export const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp']);

// IndexedDB chat store.
export const DB_NAME = 'combsllm-chats';
export const DB_STORE = 'chats';

// Canonical media-pipeline stages used to describe a model's architecture.
// Every registry entry fills the same vocabulary so details render
// generically and future models map onto the same schema.
export const ARCHITECTURE_STAGES = [
  'tokenizer', 'patchers', 'embedders', 'encoders', 'decoder',
  'outputHead', 'deTokenizer', 'vaeDecoder', 'kvCaching'
];

export const ARCHITECTURE_STAGE_LABELS = {
  tokenizer: 'Tokenizer',
  patchers: 'Patchers',
  embedders: 'Embedders',
  encoders: 'Encoders',
  decoder: 'Decoder',
  outputHead: 'Output head',
  deTokenizer: 'De-tokenizer',
  vaeDecoder: 'VAE decoder',
  kvCaching: 'KV caching'
};

// Model registry. Each entry is one downloadable artifact plus metadata:
//   runtime: suggested default runtime ('litert' | 'tasks') — the user can
//            override it in the console; wrong combinations fail at runtime.
//   promptFormat: which manual template the tasks backend should emit
//   tags: capabilities (text|vision|audio), container (webgpu|native),
//         runtime behavior (stateful-runtime|stateless-pipeline|legacy-streaming)
//   size / architecture: display metadata for the model picker
export const MODELS = {
  'gemma-4-E2B-it-web': {
    label: 'Gemma 4 E2B',
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    file: 'gemma-4-E2B-it-web.litertlm',
    runtime: 'litert',
    promptFormat: 'gemma4',
    tags: ['text', 'webgpu', 'stateful-runtime'],
    size: '~2.58 GB',
    architecture: {
      tokenizer: 'Bundled JSON Tokenizer (Client-side)',
      patchers: 'None (Stripped for WebGPU memory limits)',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'None (Stripped for WebGPU memory limits)',
      decoder: 'Gemma 4 Decoder with MTP (Multi-Token Prediction)',
      outputHead: 'Token Probability Distribution',
      deTokenizer: 'Bundled Internal (Client-side)',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Native Memory-Mapped Stateful Cache'
    }
  },
  'gemma-4-E4B-it-web': {
    label: 'Gemma 4 E4B',
    repo: 'litert-community/gemma-4-E4B-it-litert-lm',
    file: 'gemma-4-E4B-it-web.litertlm',
    runtime: 'litert',
    promptFormat: 'gemma4',
    tags: ['text', 'webgpu', 'stateful-runtime'],
    size: '~3.66 GB',
    architecture: {
      tokenizer: 'Bundled JSON Tokenizer (Client-side)',
      patchers: 'None (Stripped for WebGPU memory limits)',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'None (Stripped for WebGPU memory limits)',
      decoder: 'Gemma 4 Decoder with MTP (Multi-Token Prediction)',
      outputHead: 'Token Probability Distribution',
      deTokenizer: 'Bundled Internal (Client-side)',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Native Memory-Mapped Stateful Cache'
    }
  },
  'gemma-4-E2B-it-web-task': {
    label: 'Gemma 4 E2B',
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    file: 'gemma-4-E2B-it-web.task',
    runtime: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma4',
    tags: ['text', 'vision', 'stateless-pipeline'],
    size: '~2.58 GB',
    architecture: {
      tokenizer: 'SentencePiece (External to graph)',
      patchers: '16x16 Raw Pixel Patches',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'Linear Projection Embedder (No heavy Vision Encoder)',
      decoder: 'Gemma 4 Decoder (Stateless Graph)',
      outputHead: 'Token IDs',
      deTokenizer: 'SentencePiece (External to graph)',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Stateless (Emulated, requires manual context appending)'
    }
  },
  'gemma-4-E4B-it-web-task': {
    label: 'Gemma 4 E4B',
    repo: 'litert-community/gemma-4-E4B-it-litert-lm',
    file: 'gemma-4-E4B-it-web.task',
    runtime: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma4',
    tags: ['text', 'vision', 'stateless-pipeline'],
    size: '~3.66 GB',
    architecture: {
      tokenizer: 'SentencePiece (External to graph)',
      patchers: '16x16 Raw Pixel Patches',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'Linear Projection Embedder (No heavy Vision Encoder)',
      decoder: 'Gemma 4 Decoder (Stateless Graph)',
      outputHead: 'Token IDs',
      deTokenizer: 'SentencePiece (External to graph)',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Stateless (Emulated, requires manual context appending)'
    }
  },
  'gemma-3n-E2B-it-web': {
    label: 'Gemma-3n E2B',
    repo: 'google/gemma-3n-E2B-it-litert-lm',
    file: 'gemma-3n-E2B-it-int4-Web.litertlm',
    runtime: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma3',
    tags: ['text', 'vision', 'audio', 'legacy-streaming'],
    size: '~2.00 GB',
    architecture: {
      tokenizer: 'Client-side Processing',
      patchers: '256x256 Image Normalization & 16kHz Audio Chunking',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'Massive Standalone Vision/Audio Encoders',
      decoder: 'Gemma 3n Decoder (MatFormer & Per-Layer Embeddings)',
      outputHead: 'Token IDs',
      deTokenizer: 'Client-side Processing',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Stateless (Lacks LiteRT-LM decoupled signatures)'
    }
  },
  'gemma-3n-E4B-it-web': {
    label: 'Gemma-3n E4B',
    repo: 'google/gemma-3n-E4B-it-litert-lm',
    file: 'gemma-3n-E4B-it-int4-Web.litertlm',
    runtime: 'tasks',
    sdk: TASKS_GENAI_STABLE,
    promptFormat: 'gemma3',
    tags: ['text', 'vision', 'audio', 'legacy-streaming'],
    size: '~4.00 GB',
    architecture: {
      tokenizer: 'Client-side Processing',
      patchers: '256x256 Image Normalization & 16kHz Audio Chunking',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'Massive Standalone Vision/Audio Encoders',
      decoder: 'Gemma 3n Decoder (MatFormer & Per-Layer Embeddings)',
      outputHead: 'Token IDs',
      deTokenizer: 'Client-side Processing',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Stateless (Lacks LiteRT-LM decoupled signatures)'
    }
  },
  'gemma-3n-E2B-it-litert': {
    label: 'Gemma-3n E2B',
    repo: 'google/gemma-3n-E2B-it-litert-lm',
    file: 'gemma-3n-E2B-it-int4.litertlm',
    runtime: 'litert',
    promptFormat: 'gemma3',
    tags: ['text', 'vision', 'audio', 'native'],
    size: '~2.00 GB',
    architecture: {
      tokenizer: 'Bundled Internal',
      patchers: 'Internal High-Res Patching',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'Full Heavyweight Vision & Audio Encoders',
      decoder: 'Gemma 3n Decoder',
      outputHead: 'Token IDs',
      deTokenizer: 'Bundled Internal',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Native Stateful (Memory-mapped cache)'
    }
  },
  'gemma-3n-E4B-it-litert': {
    label: 'Gemma-3n E4B',
    repo: 'google/gemma-3n-E4B-it-litert-lm',
    file: 'gemma-3n-E4B-it-int4.litertlm',
    runtime: 'litert',
    promptFormat: 'gemma3',
    tags: ['text', 'vision', 'audio', 'native'],
    size: '~4.00 GB',
    architecture: {
      tokenizer: 'Bundled Internal',
      patchers: 'Internal High-Res Patching',
      embedders: 'Text Embedding Lookup Table',
      encoders: 'Full Heavyweight Vision & Audio Encoders',
      decoder: 'Gemma 3n Decoder',
      outputHead: 'Token IDs',
      deTokenizer: 'Bundled Internal',
      vaeDecoder: 'None (Text-out only)',
      kvCaching: 'Native Stateful (Memory-mapped cache)'
    }
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
