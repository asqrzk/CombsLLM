# CombsLLM — Agent Guide

Hosted web platform of the Combs ecosystem. **Zero-build vanilla JS** —
no bundler, no package.json for the app; deps are pinned CDN ESM imports.
Keep it that way.

## Layout

- `index.html`, `app.js`, `css/`, `presets.json` — app shell
- `js/` → being restructured into `atoms/` + `flows/` (Phase 1)
  - `atoms/` — capability units (backends, model-cache, store, chat-ui,
    mcp, agent-runner, auth, emoji…). Narrow contracts, NO page code.
  - `flows/` — one file per page (chat, kv-chat, emoji-studio,
    agent-runs), wired via `flows/registry.js`.
- `server/` — Deno hosted layer (Phase 3+): static, `/api/authn`,
  `/api/relay`, `/api/emoji`. Runtime secrets live in `server/data/` and
  `server/*.key` (gitignored, mode 600).
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
```

Regression checklist after ANY change (manual, browser):
1. Chat works on the litert backend (streaming, markdown/KaTeX)
2. Vision: attach image on a tasks/Gemma-3n preset → answer mentions it
3. Agent run: starts, calls a tool, exports run JSON
4. Chats persist across reload (IndexedDB)

## Notes

- HF token field (engine console) is per-user, stored client-side only.
- Secrets must never be committed — `issues.md` was deleted for this
  reason (2026-08-04); check `git status` before committing.
- Subdomain agent pods (Phase 5): origin isolation (ports locally,
  subdomains hosted) gives each agent its own storage quota + ~4GB heap.
