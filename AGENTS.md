# CombsLLM — Agent Guide

Hosted web platform of the Combs ecosystem. **Zero-build vanilla JS** —
no bundler, no package.json for the app; deps are pinned CDN ESM imports.
Keep it that way.

## Layout

- `index.html`, `app.js`, `css/`, `presets.json` — app shell
- `atoms/` — capability units (backends/, model-cache, model-picker,
  store, chat-ui, composer/(image,audio), mcp, context-budget, prompts,
  presets, system-info, terminal, text, ui, dom, state). Narrow
  contracts, NO page code.
- `flows/` — one file per page (`agent-runs.js`, future: kv-chat,
  emoji-studio), wired via `flows/registry.js`. The chat flow is still
  shell-owned by `app.js` (extraction is future work).
- `tests/` — browser smoke page (`/tests/` when served), no framework.
- `server/` — Deno hosted layer: static serving, `/api/auth/*` (passkey
  gate + sessions, `authn.ts`), `/api/relay` (permission-gated outbound
  proxy), `/api/permissions/*` (`permissions.ts`). Dual-mode: local dev /
  self-host / hosted — same code, env-configured (`PORT`, `HOST`,
  `COMBSLLM_RP_ID`, `COMBSLLM_ORIGINS`, `COMBS_HOME`, `COMBSLLM_DATA`).
  App data in `server/data/` (gitignored, mode 600); passkey credentials
  global in `$COMBS_HOME/authn.json` (shared with the whole Combs
  ecosystem on the machine).
- `atoms/auth/` — client gate: server probe → passkey overlay → reload.
  Static hosting skips the gate entirely.
- `atoms/relay/` — `relayFetch`: routed via `/api/relay` when server-
  hosted (428 → permission dialog → decide → retry), direct fetch when
  static.
- `atoms/emoji/` — client for the server's `/api/emoji/*` living-emoji
  host (`emojiHost` wrappers + frame/unicode decoders).
- `server/emoji.ts` — the living-emoji interpreter (spark-fox + nyx-owl):
  character logic lives in the emoji's blocks; host builds/renders/
  interprets via `@combs/mesh` FFI (`COMBS_MESH_LIB`) and voices personas
  through `combs serve` (`COMBS_ENGINE_URL`). Degrades to 503 with setup
  instructions when the dylib is absent — platform unaffected.
- `flows/emoji-studio.html` — standalone flow page (stage canvas, state
  panels, chat, version chain w/ time-travel checkout, unicode viewer).
- `atoms/pods/` — origin-isolated agent runtimes: local pods = extra
  ports on the same server (`COMBSLLM_POD_PORTS=8902,8903`), hosted pods
  = subdomains (`run-<n>.<domain>`, needs `COMBSLLM_COOKIE_DOMAIN=.<domain>`
  + wildcard TLS). Passkey session is shared (host-scoped cookies on
  localhost; Domain cookie hosted). Model bytes reach pods via own-cache
  → parent postMessage transfer (zero-copy) → direct download.
- `flows/pod.html` — pod page: isolation proof (heap/quota per origin),
  model load, in-pod inference. Spawn from the agents page (🛰 button).
  Full ToolLoopAgent-in-pod is a later increment.
- `mcp-proxy.mjs` — zero-dep Node CORS proxy for local MCP servers
- `docs/` — learnings + archive

## Hard rules

1. **Atoms never import flows; flows never contain capability logic.**
   Cross-atom communication via explicit params/events only. Adding a
   flow = registry entry + wiring file, never surgery on atoms.
2. **Surface product**: consume published packages (npm `combs-client`,
   JSR `@combs/mesh`, `@combs/zerotrust`) and HTTP services. Never
   reimplement inference, `.cmse`/PUA, or crypto. Never edit the sibling
   repos from here.
3. **No build step.** ES modules + CDN imports (jsDelivr `+esm`, pinned
   versions — see `js/ai-sdk.js` header for the zod-dedup lesson).
4. Git: remote `origin = github.com/asqrzk/CombsLLM`, default branch
   `main` (agentic==main; `soc` archived at tag `archive/soc`). No git
   mutations without explicit user approval.

## Run / smoke

```sh
python3 -m http.server 8000    # static app
deno task serve                # full platform on :8787 (PORT env to change)
deno task check                # server type-check
deno task test:remote          # combs-remote KV reuse (needs combs serve :8475)
deno task test:emoji           # emoji host (needs COMBS_MESH_LIB + COMBS_ENGINE_URL)
```

Regression checklist after ANY change (manual, browser):
1. Chat works on the litert backend (streaming, markdown/KaTeX)
2. Vision: attach image on a tasks/Gemma-3n preset → answer mentions it
3. Agent run: starts, calls a tool, exports run JSON
4. Chats persist across reload (IndexedDB)
5. `/tests/` smoke page: ALL PASS

## Notes

- HF token field (engine console) is per-user, stored client-side only.
- Secrets must never be committed — `issues.md` was deleted for this
  reason (2026-08-04); check `git status` before committing.
- Subdomain agent pods: origin isolation (ports locally,
  subdomains hosted) gives each agent its own storage quota + ~4GB heap;
  WebAuthn RP "localhost" covers all localhost ports, so local pods
  inherit the passkey session — hosted pods inherit it via the Domain
  cookie.
