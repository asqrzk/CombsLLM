// ============================================================
// relay atom — permission-gated network access via the server.
//
// When the CombsLLM server serves the app, outbound requests should go
// through POST /api/relay: the backend checks the grant store and
// answers 428 {permissionRequired} when ungranted — this atom shows the
// decision dialog, posts the grant, and retries. Grants:
//   once    — this attempt only
//   session — until the server restarts
//   always  — persisted on the server
//   deny    — blocked
// When there is no server (static hosting), relayFetch falls back to a
// direct fetch — local/static usage stays ungated by design.
// ============================================================

import { hasServer } from '../auth/index.js';

let relayAvailable = null;
async function useRelay() {
  if (relayAvailable === null) relayAvailable = await hasServer();
  return relayAvailable;
}

/**
 * fetch() through the permission gate.
 *   await relayFetch(url, {method, headers, body, scope, detail})
 * `scope` is the grant key (e.g. 'net:combs-engine'); `detail` is shown
 * in the dialog. Returns the upstream Response (SSE-safe: body streams).
 */
export async function relayFetch(url, { method = 'GET', headers = {}, body = null, scope, detail, signal } = {}) {
  if (!(await useRelay())) {
    return fetch(url, { method, headers, body: body ?? undefined, cache: 'no-store', signal });
  }

  const attempt = () => fetch('/api/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, method, headers, body, scope, detail }),
    cache: 'no-store',
    signal,
  });

  let res = await attempt();
  if (res.status === 428) {
    const { permissionRequired } = await res.json();
    const grant = await askPermission(permissionRequired.scope, permissionRequired.detail);
    if (grant === 'deny') throw new Error(`permission denied: ${scope}`);
    await fetch('/api/permissions/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, grant }),
      signal,
    });
    res = await attempt();
  }
  return res;
}

// ── permission dialog (self-contained, app-styled) ──────────────────
function askPermission(scope, detail) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.innerHTML = `
      <style>
        .perm-backdrop { position: fixed; inset: 0; z-index: 9998;
          background: rgba(0,0,0,.35); display: flex; align-items: center;
          justify-content: center; font-family: inherit; }
        .perm-card { background: #fff; border-radius: 12px; padding: 1.5rem;
          max-width: 24rem; box-shadow: 0 12px 40px rgba(0,0,0,.2); }
        .perm-card h2 { font-size: 1rem; margin: 0 0 .4rem; color: #18181b; }
        .perm-card p { font-size: .82rem; color: #52525b; margin: 0 0 1rem;
          word-break: break-all; }
        .perm-card .scope { font-family: monospace; font-size: .78rem;
          background: #f4f4f5; border-radius: 6px; padding: .15rem .4rem; }
        .perm-btns { display: flex; gap: .5rem; flex-wrap: wrap; }
        .perm-btns button { border: 1px solid #d4d4d8; background: #fff;
          border-radius: 8px; padding: .45rem .9rem; font-size: .82rem;
          cursor: pointer; }
        .perm-btns .primary { background: #18181b; color: #fafafa; border-color: #18181b; }
        .perm-btns .danger { color: #dc2626; border-color: #fecaca; }
      </style>
      <div class="perm-backdrop">
        <div class="perm-card">
          <h2>Permission request</h2>
          <p>CombsLLM wants to make this request:<br><br>
             <span class="scope">${escapeHtml(scope)}</span><br><br>
             ${escapeHtml(detail || '')}</p>
          <div class="perm-btns">
            <button class="primary" data-g="once">Allow once</button>
            <button data-g="session">Allow this session</button>
            <button data-g="always">Always allow</button>
            <button class="danger" data-g="deny">Deny</button>
          </div>
        </div>
      </div>`;
    el.addEventListener('click', (e) => {
      const grant = e.target?.dataset?.g;
      if (!grant) return;
      el.remove();
      resolve(grant);
    });
    document.body.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
