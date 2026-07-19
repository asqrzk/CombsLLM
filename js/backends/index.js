// ============================================================
// Backend factory — the model registry entry picks the runtime.
// ============================================================
import { LitertBackend } from './litert.js';
import { TasksBackend } from './tasks.js';

export function createBackend(modelDef) {
  return modelDef.backend === 'tasks' ? new TasksBackend(modelDef) : new LitertBackend();
}
