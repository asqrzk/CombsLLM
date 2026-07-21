// ============================================================
// Backend factory — the model registry entry picks the runtime.
// ============================================================
import { LitertBackend } from './litert.js';
import { TasksBackend } from './tasks.js';
import { LitertJsBackend } from './litertjs.js';

export function createBackend(runtime, modelDef) {
  if (runtime === 'tasks') return new TasksBackend(modelDef);
  if (runtime === 'litertjs') return new LitertJsBackend();
  return new LitertBackend();
}
