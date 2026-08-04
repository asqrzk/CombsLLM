# CombsLLM — the hosted Combs web platform

A **zero-build, vanilla-JS web app** that puts the best of the Combs
ecosystem in the browser: true on-device multimodal inference (WebGPU),
agent runs with supervisor loops, MCP tools — plus server-backed flows
(KV-cached chat, living emojis) powered by
[CombsEngine](https://github.com/asqrzk/CombsEngine).

## Run it

```sh
# static only (on-device inference, no server features, no gate)
python3 -m http.server 8000        # → http://localhost:8000

# full platform (passkey gate, permission relay, emoji studio) — local dev & self-host
deno task serve
# → http://localhost:8787  (first run: create your passkey)
#
# emoji studio additionally needs the mesh dylib + a running combs serve:
#   COMBS_MESH_LIB=~/Projects/CombsEngine/engine/core/target/release/libcombsmesh_ffi.dylib \
#   COMBS_ENGINE_URL=http://127.0.0.1:8080 \
#   deno task serve      # then open /flows/emoji-studio.html

# hosted: same command behind HTTPS with env config:
#   HOST=0.0.0.0 PORT=443 COMBSLLM_RP_ID=your.domain \
#   COMBSLLM_ORIGINS=https://your.domain COMBS_HOME=/srv/combsllm/home \
#   deno run --allow-net --allow-read --allow-write --allow-env server/main.ts
```

First run downloads a multi-GB model from HuggingFace into the browser's
Cache Storage (progress bar + storage manager in the engine console).

## What's inside

- **On-device backends** (`atoms/backends/`): LiteRT-LM (WebGPU, KV-cached
  conversations, vision+audio), MediaPipe tasks-genai ("modelpipe" —
  Gemma 3n image/audio→text), litertjs (.tflite classics like MobileNet).
- **Agent runs**: Vercel AI SDK `ToolLoopAgent` driving *on-device* models
  via custom LanguageModel adapters, with VALIDATOR + STRATEGIST
  supervisor cycles; MCP tools (Playwright etc.) via the bundled client.
- **Server flows** (being added incrementally): `kv-chat` (combs serve
  rolling-session KV reuse with live cached-token stats), `emoji-studio`
  (CombsMesh living emojis), passkey gate.

## Architecture — atoms → flows

Capabilities live in `atoms/` (narrow contracts, no page code); pages are
`flows/` — one file each, wired through `flows/registry.js`. Atoms never
import flows; flows never contain capability logic. See `AGENTS.md`.

## Boundaries

CombsLLM is a **surface product**. It consumes published packages
(`combs-client`, `@combs/mesh`, `@combs/zerotrust`) and HTTP services
(`combs serve`) — it never reimplements inference, wire formats, or
crypto. Protocol/compute live in CombsEngine; agent runtimes/fabric live
in CombsMesh.

## Docs

- `docs/litert-learnings.md` — hard-won LiteRT/modelpipe notes
- `docs/archive/` — original design conversations (historical)
