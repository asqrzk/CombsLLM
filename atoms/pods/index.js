// ============================================================
// pods atom — origin-isolated agent runtimes.
//
// Why: a single browser tab shares one storage quota and one ~4GB
// renderer heap. Agents carrying multi-GB models need ISOLATED origins:
//   local dev : http://localhost:<podPort>   (extra listeners on the
//                same server via COMBSLLM_POD_PORTS; the passkey session
//                cookie is host-scoped, so it is shared across ports,
//                and RP "localhost" covers every localhost port)
//   hosted    : https://run-<id>.<domain>     (wildcard DNS + TLS; needs
//                COMBSLLM_COOKIE_DOMAIN=".<domain>" so the session
//                cookie reaches subdomains)
//
// Model bytes: pods first try their own Cache API (warm on repeat
// visits), then ask the parent window for a zero-copy ArrayBuffer
// transfer via postMessage, then fall back to a direct download.
// ============================================================

const LS_POD_SEQ = 'combsllm.podSeq';

/** The root host pods are derived from (strip one label on domains). */
export function podRootHost() {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return host;
  const parts = host.split('.');
  return parts.length > 2 ? parts.slice(1).join('.') : host;
}

export function isLocalPods() {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

/**
 * Compute the next pod origin.
 * Local: http://localhost:<podPort> — pod ports come from the server
 * (COMBSLLM_POD_PORTS), discovered via /api/pods (falls back to
 * location.port + seq for static/dev).
 * Hosted: https://run-<seq>.<rootDomain> (same scheme/port as the app).
 */
export async function nextPodOrigin() {
  const seq = (parseInt(localStorage.getItem(LS_POD_SEQ) || '0') + 1);
  localStorage.setItem(LS_POD_SEQ, String(seq));

  if (isLocalPods()) {
    let ports = [];
    try {
      const res = await fetch('/api/pods', { cache: 'no-store' });
      if (res.ok) ports = (await res.json()).podPorts ?? [];
    } catch { /* static */ }
    const base = ports.length ? ports : [parseInt(location.port) + seq];
    return `http://localhost:${base[(seq - 1) % base.length]}`;
  }
  return `${location.protocol}//run-${seq}.${podRootHost()}${location.port ? ':' + location.port : ''}`;
}

/** Open a pod page on a fresh isolated origin. Returns the Window. */
export async function openPod(path = '/flows/pod.html') {
  const origin = await nextPodOrigin();
  const win = window.open(`${origin}${path}`, `pod-${Date.now()}`);
  if (!win) throw new Error('pod window blocked — allow popups for this site');
  return { win, origin };
}

// ── handshake (parent side) ─────────────────────────────────────────
// Pod posts {type:'pod:ready'} → parent answers {type:'pod:init', ...}.
// Pod may post {type:'pod:model-request', modelUrl} → parent reads its
// own Cache API and transfers the bytes back ({type:'pod:model-bytes'}).
export function listenToPod(win, origin, { onReady, onModelRequest } = {}) {
  const handler = async (event) => {
    if (event.origin !== origin || event.source !== win) return;
    const msg = event.data || {};
    if (msg.type === 'pod:ready') {
      win.postMessage({ type: 'pod:init', session: true }, origin);
      onReady?.();
    }
    if (msg.type === 'pod:model-request' && onModelRequest) {
      onModelRequest(msg.modelUrl);
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/** Answer a pod's model request with bytes from OUR cache (zero-copy). */
export async function sendModelBytes(win, origin, modelUrl) {
  try {
    const cache = await caches.open('litert-models-v1');
    const res = await cache.match(modelUrl);
    const buf = res ? await res.arrayBuffer() : null;
    win.postMessage({ type: 'pod:model-bytes', modelUrl, bytes: buf }, origin, buf ? [buf] : []);
    return !!buf;
  } catch {
    win.postMessage({ type: 'pod:model-bytes', modelUrl, bytes: null }, origin);
    return false;
  }
}

// ── handshake (pod side) ────────────────────────────────────────────
export function podHandshake({ onInit, onModelBytes } = {}) {
  const pending = new Map(); // modelUrl -> resolve(bytes|null)
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'pod:init') onInit?.(msg);
    if (msg.type === 'pod:model-bytes') {
      pending.get(msg.modelUrl)?.(msg.bytes ?? null);
      pending.delete(msg.modelUrl);
      onModelBytes?.(msg);
    }
  });
  if (window.opener) window.opener.postMessage({ type: 'pod:ready' }, '*');
  return {
    requestModel(modelUrl, timeoutMs = 120000) {
      return new Promise((resolve) => {
        pending.set(modelUrl, resolve);
        if (window.opener) window.opener.postMessage({ type: 'pod:model-request', modelUrl }, '*');
        setTimeout(() => { if (pending.delete(modelUrl)) resolve(null); }, timeoutMs);
      });
    },
  };
}
