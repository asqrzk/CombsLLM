// ============================================================
// auth atom — passkey session gate for the CombsLLM server.
//
// Boot contract: when the app is served by server/main.ts, the app
// boots BEHIND the passkey gate — no session → full-screen overlay
// (register on first run, login after) → reload into the app.
// When served statically (python http.server, any CDN) there is no
// gate: the app stays fully usable with on-device backends.
//
// Same code locally and hosted — the server's RP_ID/origins are
// env-configured; WebAuthn treats localhost as a secure context.
// ============================================================

const SWA_CDN = 'https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@^13/+esm';

/** Is this page served by the CombsLLM server? (one probe, cached) */
let serverProbe = null;
export async function hasServer() {
  if (serverProbe) return serverProbe;
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store' });
    serverProbe = Promise.resolve(res.ok || res.status === 401);
  } catch {
    serverProbe = Promise.resolve(false);
  }
  return serverProbe;
}

export async function authSession() {
  const res = await fetch('/api/auth/session', { cache: 'no-store' });
  if (!res.ok) return { authenticated: false };
  return res.json();
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}

async function api(path, body) {
  const res = await fetch(`/api/auth/passkey/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

function overlay(html) {
  const el = document.createElement('div');
  el.id = 'auth-gate';
  el.innerHTML = `
    <style>
      #auth-gate { position: fixed; inset: 0; z-index: 9999; display: flex;
        align-items: center; justify-content: center;
        background: #f4f4f5; font-family: inherit; }
      #auth-gate .card { background: #fff; border: 1px solid #e4e4e7;
        border-radius: 12px; padding: 2rem 2.25rem; max-width: 22rem;
        box-shadow: 0 8px 30px rgba(0,0,0,.08); text-align: center; }
      #auth-gate h1 { font-size: 1.15rem; margin: 0 0 .5rem; color: #18181b; }
      #auth-gate p { font-size: .85rem; color: #52525b; margin: 0 0 1.25rem; }
      #auth-gate button { background: #18181b; color: #fafafa; border: 0;
        border-radius: 8px; padding: .6rem 1.4rem; font-size: .9rem;
        cursor: pointer; }
      #auth-gate button:disabled { opacity: .5; cursor: wait; }
      #auth-gate .err { color: #dc2626; font-size: .8rem; margin-top: .75rem; min-height: 1em; }
    </style>
    <div class="card">${html}</div>`;
  document.body.appendChild(el);
  return el;
}

/**
 * Boot the gate. Returns true when the app may start (no server, or an
 * authenticated session exists). Otherwise shows the passkey overlay and
 * returns false — the app stays frozen until the ceremony reloads it.
 */
export async function bootAuthGate() {
  if (!(await hasServer())) return true;
  const { authenticated } = await authSession();
  if (authenticated) return true;

  const { startRegistration, startAuthentication } = await import(SWA_CDN);
  const status = await (await fetch('/api/auth/passkey/status')).json();
  const isRegister = !status.registered;

  const el = overlay(`
    <h1>CombsLLM</h1>
    <p>${isRegister
      ? 'First run on this device — create a passkey to unlock the platform. It doubles as your approval key for permission requests.'
      : 'Unlock with your passkey to continue.'}</p>
    <button id="auth-go">${isRegister ? 'Create passkey' : 'Unlock'}</button>
    <div class="err" id="auth-err"></div>`);

  const btn = el.querySelector('#auth-go');
  const err = el.querySelector('#auth-err');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    err.textContent = '';
    try {
      if (isRegister) {
        const options = await api('register-options', {});
        const response = await startRegistration({ optionsJSON: options });
        const { verified } = await api('register-verify', { response });
        if (!verified) throw new Error('registration rejected');
      } else {
        await tryLogin(startAuthentication, false);
      }
      location.reload();
    } catch (e) {
      // Stale pinned credential → retry once with the discoverable flow.
      if (!isRegister && /NotAllowed|unknown/i.test(e.message)) {
        try { await tryLogin(startAuthentication, true); location.reload(); return; } catch { /* fall through */ }
      }
      err.textContent = e.message || 'ceremony failed';
      btn.disabled = false;
    }
  });
  return false;
}

async function tryLogin(startAuthentication, allowAny) {
  const options = await api('auth-options', { allowAny });
  const response = await startAuthentication({ optionsJSON: options });
  const result = await api('auth-verify', { response });
  if (!result.verified) throw new Error(result.error || 'assertion rejected');
}
