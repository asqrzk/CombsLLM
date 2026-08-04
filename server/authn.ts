/**
 * Passkey (WebAuthn) ceremonies + session gate for the CombsLLM server.
 * Ported from CombsEngine's proven authn.mjs (SimpleWebAuthn), adapted to
 * Deno and extended with login sessions.
 *
 * Dual-mode by design: the same code serves local development and the
 * hosted deployment — RP ID / origins / storage are env-configured:
 *   COMBSLLM_RP_ID    default "localhost" (local: any port shares the RP;
 *                     hosted: set to the bare domain, e.g. "combsllm.dev")
 *   COMBSLLM_ORIGINS  default localhost:8787/8000 (hosted: https origins)
 *   COMBS_HOME        credential store dir (default ~/.cache/combs — one
 *                     device passkey serves the whole Combs ecosystem on
 *                     this machine; hosted: point at the instance dir)
 *
 * Endpoints (under /api/auth/):
 *   GET  session                      → {authenticated}
 *   POST logout                       → clears the session cookie
 *   GET  passkey/status               → {registered}
 *   POST passkey/register-options     → PublicKeyCredentialCreationOptions
 *   POST passkey/register-verify      → {verified} + session cookie
 *   POST passkey/auth-options         → PublicKeyCredentialRequestOptions
 *   POST passkey/auth-verify          → {verified} + session cookie
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@^13";

const RP_NAME = "CombsLLM";
const RP_ID = Deno.env.get("COMBSLLM_RP_ID") || "localhost";
const ORIGINS = (
  Deno.env.get("COMBSLLM_ORIGINS") ||
  "http://localhost:8787,http://localhost:8000,http://127.0.0.1:8787"
).split(",").map((s) => s.trim());
const CHALLENGE_TTL = 5 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

const CRED_DIR = Deno.env.get("COMBS_HOME") ||
  `${Deno.env.get("HOME") || "."}/.cache/combs`;
const CRED_FILE = `${CRED_DIR}/authn.json`;

export const SESSION_COOKIE = "combsllm_session";

// ── base64 helpers — MUST match @combs/zerotrust's encoding, because
// the credential store is shared with the engine's apps: base64url,
// unpadded (+ → -, / → _, no "="). Decode accepts both alphabets.
function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replaceAll("-", "+").replaceAll("_", "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Mirrors SimpleWebAuthn's AuthenticatorTransportFuture (not re-exported
// by the server package's entrypoint).
type AuthenticatorTransport =
  | "usb" | "nfc" | "ble" | "cable" | "internal" | "hybrid" | "smart-card";

interface StoredCredential {
  id: string;
  publicKey: string; // base64
  counter: number;
  transports: AuthenticatorTransport[];
}

// ── credential store ────────────────────────────────────────────────
async function loadCredentials(): Promise<StoredCredential[]> {
  try {
    return JSON.parse(await Deno.readTextFile(CRED_FILE)).credentials ?? [];
  } catch { /* first run */ }
  return [];
}
async function saveCredentials(credentials: StoredCredential[]): Promise<void> {
  await Deno.mkdir(CRED_DIR, { recursive: true });
  await Deno.writeTextFile(CRED_FILE, JSON.stringify({ credentials }, null, 2));
  try { await Deno.chmod(CRED_FILE, 0o600); } catch { /* windows */ }
}

const challenges = new Map<string, { challenge: string; expires: number }>();
function setChallenge(kind: string, challenge: string): void {
  challenges.set(kind, { challenge, expires: Date.now() + CHALLENGE_TTL });
}
function takeChallenge(kind: string): string {
  const c = challenges.get(kind);
  challenges.delete(kind);
  if (!c || c.expires < Date.now()) throw new Error("challenge expired or missing");
  return c.challenge;
}

// ── sessions (in-memory; a restart just asks for the passkey again) ──
const sessions = new Map<string, number>(); // token -> expires
export function sessionToken(req: Request): string | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const token = match[1];
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) { sessions.delete(token); return null; }
  return token;
}
function issueSession(): string {
  const token = crypto.randomUUID() + crypto.randomUUID();
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}
export function sessionCookie(token: string, secure: boolean): string {
  // Hosted pods live on subdomains — COMBSLLM_COOKIE_DOMAIN=".<domain>"
  // shares the session cookie with them (local pods on localhost ports
  // share it automatically: cookies are host-scoped, not port-scoped).
  const domain = Deno.env.get("COMBSLLM_COOKIE_DOMAIN");
  const base = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${domain ? `; Domain=${domain}` : ""}`;
  return secure ? `${base}; Secure` : base;
}
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ── handler ─────────────────────────────────────────────────────────
export async function handleAuth(req: Request, url: URL): Promise<Response> {
  const json = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string> || {}) },
    });
  const secure = url.protocol === "https:";
  const path = url.pathname;

  if (path === "/api/auth/session" && req.method === "GET") {
    return json({ authenticated: !!sessionToken(req) });
  }
  if (path === "/api/auth/logout" && req.method === "POST") {
    const token = sessionToken(req);
    if (token) sessions.delete(token);
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
  }

  const action = path.startsWith("/api/auth/passkey/")
    ? path.slice("/api/auth/passkey/".length) : null;
  if (!action) return json({ error: "unknown auth endpoint" }, { status: 404 });

  if (action === "status" && req.method === "GET") {
    const credentials = await loadCredentials();
    return json({ registered: credentials.length > 0 });
  }

  if (action === "register-options" && req.method === "POST") {
    const { username } = await req.json().catch(() => ({})) as { username?: string };
    const credentials = await loadCredentials();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: username || "combsllm-user",
      attestationType: "none",
      excludeCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    setChallenge("reg", options.challenge);
    return json(options);
  }

  if (action === "register-verify" && req.method === "POST") {
    const { response } = await req.json();
    const credentials = await loadCredentials();
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: takeChallenge("reg"),
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return json({ verified: false });
    }
    const { credential } = verification.registrationInfo;
    credentials.push({
      id: credential.id,
      publicKey: b64encode(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
    });
    await saveCredentials(credentials);
    const token = issueSession();
    return json({ verified: true }, { headers: { "set-cookie": sessionCookie(token, secure) } });
  }

  if (action === "auth-options" && req.method === "POST") {
    const { allowAny } = await req.json().catch(() => ({})) as { allowAny?: boolean };
    const credentials = await loadCredentials();
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "preferred",
      // allowAny => discoverable-credential flow (stale pinned id fallback)
      allowCredentials: allowAny
        ? []
        : credentials.map((c) => ({ id: c.id, transports: c.transports })),
    });
    setChallenge("auth", options.challenge);
    return json(options);
  }

  if (action === "auth-verify" && req.method === "POST") {
    const { response } = await req.json();
    const credentials = await loadCredentials();
    const cred = credentials.find((c) => c.id === response.id);
    if (!cred) {
      return json({ verified: false, error: "unknown credential", reregister: true });
    }
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: takeChallenge("auth"),
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
      credential: {
        id: cred.id,
        publicKey: b64decode(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
    if (!verification.verified) return json({ verified: false });
    cred.counter = verification.authenticationInfo.newCounter;
    await saveCredentials(credentials);
    const token = issueSession();
    return json({ verified: true }, { headers: { "set-cookie": sessionCookie(token, secure) } });
  }

  return json({ error: "unknown passkey endpoint" }, { status: 404 });
}
