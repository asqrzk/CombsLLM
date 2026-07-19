// ============================================================
// Backend factory — the model registry entry picks the runtime.
// ============================================================
import { LitertBackend } from './litert.js';
import { TasksBackend } from './tasks.js';

export function createBackend(runtime, modelDef) {
  return runtime === 'tasks' ? new TasksBackend(modelDef) : new LitertBackend();
}
