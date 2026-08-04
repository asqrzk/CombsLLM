/**
 * CombsLLM server — the hosted + local platform layer. ONE Deno process:
 *
 *   static app (index.html, app.js, atoms/, flows/, css/, tests/)
 *   /api/auth/*        passkey gate (register/login/logout/session)
 *   /api/relay         permission-gated outbound proxy (SSE-safe streaming)
 *   /api/permissions/* grant store (backend-owned)
 *   /api/emoji/*       living-emoji host (needs COMBS_MESH_LIB dylib)
 *
 * Dual-mode (local dev / self-host / hosted) — same code, env-configured:
 *   PORT                default 8787
 *   HOST                default 127.0.0.1 (hosted: 0.0.0.0)
 *   COMBSLLM_RP_ID      passkey RP id   (default "localhost")
 *   COMBSLLM_ORIGINS    passkey origins (default localhost ports)
 *   COMBS_HOME          passkey store   (default ~/.cache/combs)
 *   COMBSLLM_DATA       app data dir    (default server/data)
 *   COMBS_ENGINE_URL    combs serve for emoji personas (default :8080)
 *   COMBS_MESH_LIB      libcombsmesh_ffi.dylib path (emoji host)
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi server/main.ts
 *
 * The browser NEVER talks to the network ungated when served by this
 * server: API routes (except auth) require a passkey session, and relay
 * upstreams require a permission grant (428 → dialog → decide → retry).
 */

import { handleAuth, sessionToken } from "./authn.ts";
import { PermissionStore } from "./permissions.ts";
import { handleEmoji } from "./emoji.ts";

const PORT = Number(Deno.env.get("PORT") || 8787);
const HOST = Deno.env.get("HOST") || "127.0.0.1";
const ROOT = new URL("..", import.meta.url).pathname; // repo root
const DATA_DIR = Deno.env.get("COMBSLLM_DATA") || `${ROOT}server/data`;

// Pod origins (local mode): extra listeners on these ports serve the
// same app, so each pod tab gets its own origin (storage quota + heap).
// Hosted mode uses subdomains instead — see atoms/pods + deploy docs.
const POD_PORTS = (Deno.env.get("COMBSLLM_POD_PORTS") || "")
  .split(",").map((s) => parseInt(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

const permissions = new PermissionStore(`${DATA_DIR}/permissions.json`);
await Deno.mkdir(DATA_DIR, { recursive: true });
await permissions.load();

// ── helpers ─────────────────────────────────────────────────────────
function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...((init.headers as Record<string, string>) || {}) },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = `${ROOT}${rel}`;
  if (!file.startsWith(ROOT) || rel.includes("..")) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  // Never serve server-side data or secrets.
  if (rel.startsWith("server/data/") || rel.endsWith(".key")) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  try {
    // Directory → its index.html (e.g. /flows/ → flows/index.html).
    const stat = await Deno.stat(file).catch(() => null);
    const target = stat?.isDirectory ? `${file.replace(/\/+$/, "")}/index.html` : file;
    const data = await Deno.readFile(target);
    const ext = target.slice(target.lastIndexOf("."));
    return new Response(data, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    // SPA fallback only for navigation requests (no file extension).
    // Asset misses get a real 404 — never HTML masquerading as CSS/JS.
    const base = rel.split("/").pop() ?? "";
    if (base.includes(".")) {
      return json({ error: "not found" }, { status: 404 });
    }
    try {
      const data = await Deno.readFile(`${ROOT}index.html`);
      return new Response(data, { headers: { "content-type": MIME[".html"] } });
    } catch {
      return json({ error: "not found" }, { status: 404 });
    }
  }
}

// ── relay (permission-gated, SSE-safe) ──────────────────────────────
async function handleRelay(req: Request): Promise<Response> {
  const { url, method = "GET", headers = {}, body = null, scope, detail } =
    await req.json().catch(() => ({})) as {
      url?: string; method?: string; headers?: Record<string, string>;
      body?: string | null; scope?: string; detail?: string;
    };
  if (!url || !scope) return json({ error: "relay needs {url, scope}" }, { status: 400 });

  const verdict = permissions.check(scope);
  if (verdict === "deny") return json({ error: `permission denied: ${scope}` }, { status: 403 });
  if (verdict === "ask") {
    // 428 Precondition Required — the frontend shows the dialog, POSTs the
    // decision to /api/permissions/decide, then retries.
    return json({ permissionRequired: { scope, detail: detail ?? `${method} ${url}` } }, { status: 428 });
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      cache: "no-store" as RequestCache, // SSE: no buffering
    });
  } catch (e) {
    return json({ error: `upstream unreachable: ${(e as Error).message}` }, { status: 502 });
  }

  const pass = new Headers();
  for (const h of ["content-type", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) pass.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: pass });
}

// ── router ──────────────────────────────────────────────────────────
const PUBLIC_API = [
  "/api/auth/session",
  "/api/auth/passkey/status",
  "/api/auth/passkey/register-options",
  "/api/auth/passkey/register-verify",
  "/api/auth/passkey/auth-options",
  "/api/auth/passkey/auth-verify",
];

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path.startsWith("/api/auth/")) return await handleAuth(req, url);

    // Everything else under /api requires a passkey session.
    if (path.startsWith("/api/") && !PUBLIC_API.includes(path) && !sessionToken(req)) {
      return json({ error: "authentication required" }, { status: 401 });
    }

    if (path === "/api/relay" && req.method === "POST") return await handleRelay(req);
    if (path.startsWith("/api/emoji/")) return await handleEmoji(req, url);

    if (path === "/api/permissions" && req.method === "GET") {
      return json(permissions.snapshot());
    }
    if (path === "/api/pods" && req.method === "GET") {
      return json({ podPorts: POD_PORTS });
    }
    if (path === "/api/permissions/decide" && req.method === "POST") {
      const { scope, grant } = await req.json().catch(() => ({})) as { scope?: string; grant?: string };
      if (!scope || !grant || !PermissionStore.isValidGrant(grant)) {
        return json({ error: "need {scope, grant}" }, { status: 400 });
      }
      await permissions.decide(scope, grant);
      return json({ ok: true });
    }

    if (path.startsWith("/api/")) return json({ error: "not found" }, { status: 404 });
    return await serveStatic(path);
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 500 });
  }
}

Deno.serve({ port: PORT, hostname: HOST }, handler);
console.log(`[combsllm] listening on http://${HOST}:${PORT}`);
for (const podPort of POD_PORTS) {
  Deno.serve({ port: podPort, hostname: HOST }, handler);
  console.log(`[combsllm] pod origin: http://${HOST}:${podPort}`);
}
console.log(`[combsllm] serving app from ${ROOT}`);
console.log(`[combsllm] data dir: ${DATA_DIR}`);
console.log(`[combsllm] passkey RP: ${Deno.env.get("COMBSLLM_RP_ID") || "localhost"} (origins: ${Deno.env.get("COMBSLLM_ORIGINS") || "localhost defaults"})`);
console.log(`[combsllm] emoji host: ${Deno.env.get("COMBS_MESH_LIB") ? `enabled (${Deno.env.get("COMBS_MESH_LIB")})` : "DISABLED — set COMBS_MESH_LIB to libcombsmesh_ffi.dylib"}`);
