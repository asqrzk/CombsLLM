// ============================================================
// Shared mutable application state (single source of truth).
// ============================================================
import { SYSTEM_PREFACE } from './config.js';

export const state = {
  backend: null,          // active backend instance (LitertBackend | TasksBackend)
  activeMessagesLog: [{ role: 'system', content: SYSTEM_PREFACE }],
  activeChatId: null,
  activeChatModel: null,
  currentModel: null,
  modelBlobUrl: null,     // object URL handed to the engine; revoked on swap
  generating: false,
  pruning: false,
  isRestoring: false
};
