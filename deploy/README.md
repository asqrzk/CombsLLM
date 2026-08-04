# Deploying CombsLLM

One Deno process serves the app + platform APIs; an optional `combs serve`
sidecar provides server-side inference + emoji personas. The same image
covers self-host and the public hosted deployment.

## Modes

| | Local dev | Self-host | Hosted |
|---|---|---|---|
| serve | `deno task serve` | same / Docker | Docker + HTTPS |
| passkey RP | `localhost` | `COMBSLLM_RP_ID=host` | apex domain |
| pod isolation | `COMBSLLM_POD_PORTS=8902,8903` | same | subdomains `run-N.*` |
| session cookie | host-scoped (shared across ports) | same | `COMBSLLM_COOKIE_DOMAIN=.<domain>` |

## Environment matrix

| Var | Default | Hosted value |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | `8787` / `0.0.0.0` (proxy terminates TLS) |
| `COMBSLLM_RP_ID` | `localhost` | `example.com` (bare domain — no port, no scheme) |
| `COMBSLLM_ORIGINS` | localhost ports | `https://example.com,https://run-1.example.com,…` |
| `COMBSLLM_COOKIE_DOMAIN` | *(host-only)* | `.example.com` (shares session with pod subdomains) |
| `COMBSLLM_POD_PORTS` | — | — (hosted pods are subdomains, not ports) |
| `COMBSLLM_DATA` | `server/data` | `/data/app` |
| `COMBS_HOME` | `~/.cache/combs` | `/data/home` (passkey creds + emoji registry + models) |
| `COMBS_MESH_LIB` | — (emoji host off) | `/opt/combs/libcombsmesh_ffi.so` |
| `COMBS_ENGINE_URL` | `http://127.0.0.1:8080` | `http://engine:8080` (compose service) |

## Wildcard DNS + TLS (for subdomain pods)

1. DNS: `A example.com → <ip>` **and** `A *.example.com → <ip>`.
2. TLS must be a **wildcard cert** — Let's Encrypt requires the DNS-01
   challenge for wildcards. Easiest path is Caddy with a DNS provider
   plugin:

   ```caddyfile
   example.com, *.example.com {
       tls {
           dns cloudflare {env.CLOUDFLARE_API_TOKEN}
       }
       reverse_proxy 127.0.0.1:8787
   }
   ```

   (certbot + nginx works too: `certbot --dns-<provider> -d example.com -d '*.example.com'`.)
3. Pods then get `https://run-1.example.com`, `https://run-2.example.com`…
   automatically — no per-pod cert or vhost work.

## First-run checklist (hosted)

1. `docker compose up -d` behind the TLS proxy.
2. Open `https://example.com` → create the passkey (WebAuthn binds it to
   `COMBSLLM_RP_ID` — get the env var right BEFORE registering, or delete
   `$COMBS_HOME/authn.json` and re-register).
3. Engine console → model picker: on-device models download to the
   visitor's browser (HF token field for gated repos stays per-user).
4. Emoji studio: verify `/flows/emoji-studio.html` hatches Spark-Fox
   (needs `COMBS_MESH_LIB` + the engine sidecar healthy).
5. Pods: agents page → 🛰 Spawn pod → confirm the pod opens on a
   `run-N.` subdomain and reports its own heap/quota.

## Notes

- **Models**: on-device (LiteRT) models are downloaded by each visitor's
  browser into Cache Storage — the server never proxies gigabytes. The
  server-side engine model lives in the shared volume (`combs pull`).
- **macOS dev**: Docker has no Metal passthrough — run `combs serve`
  natively and set `COMBS_ENGINE_URL=http://host.docker.internal:8080`.
- **Updates**: `git pull && docker compose build && docker compose up -d`;
  engine upgrades = bump the `COMBS_VERSION` build arg.
