// ============================================================
// IndexedDB chat store — thin promise wrapper.
// ============================================================
import { DB_NAME, DB_STORE, AGENT_RUNS_STORE } from './config.js';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(AGENT_RUNS_STORE)) {
        const store = db.createObjectStore(AGENT_RUNS_STORE, { keyPath: 'id' });
        store.createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function idbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function idbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function idbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ---- Agent run history (separate from chat storage) ----

function withStore(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(AGENT_RUNS_STORE, mode);
    const result = fn(tx.objectStore(AGENT_RUNS_STORE));
    tx.oncomplete = () => { db.close(); resolve(result?.result !== undefined ? result.result : result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

export function idbPutAgentRun(run) {
  return withStore('readwrite', store => store.put(run));
}

export function idbGetAgentRuns() {
  return withStore('readonly', store => store.getAll()).then(
    runs => (runs || []).sort((a, b) => b.startedAt - a.startedAt)
  );
}

export function idbDeleteAgentRun(id) {
  return withStore('readwrite', store => store.delete(id));
}
