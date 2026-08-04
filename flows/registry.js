/**
 * Flow registry — the wiring table for CombsLLM.
 *
 * A **flow** is a page built by connecting atoms (atoms/ = capabilities,
 * flows/ = pages). Rules:
 *   - atoms never import flows; flows never contain capability logic
 *   - adding a flow = one entry here + one wiring file in flows/
 *
 * Mount contract for NEW flows (kv-chat, emoji-studio, …):
 *   export function mount(rootEl, ctx) — render into rootEl; ctx carries
 *   shared atoms { store, backends, auth, … } as the flow needs them.
 *   export function unmount() — release listeners/resources.
 *
 * LEGACY note (Phase 1): the chat flow is still owned by the app.js shell
 * and agent-runs mounts into existing DOM via initAgents(). They appear
 * here as descriptors so the registry is the single source of truth for
 * "what pages exist"; both get the mount() contract when they're
 * extracted from the shell.
 *
 * LAUNCHER: flows/index.html renders its cards from this table. Page flows
 * carry display metadata — { icon, blurb, tag, url, needs } — where `needs`
 * names the capabilities the launcher live-probes: 'engine' (combs serve
 * /health), 'emoji-host' (/api/emoji/state), 'server' (this Deno layer).
 * Add a flow here and it appears in the launcher automatically.
 */
export const flows = {
  chat: {
    title: 'Chat',
    owner: 'shell', // app.js — extraction to flows/chat.js is future work
  },
  'kv-chat': {
    title: 'KV Chat',
    // Also reachable as a shell composition: pick the "Combs Engine
    // (remote)" model in the main chat and the per-message "KV ⚡ cached"
    // metric surfaces. This page is the dedicated full-transcript variant.
    owner: 'page',
    url: '/flows/kv-chat.html',
    icon: '⚡',
    blurb: 'Full-transcript chat on the engine\'s rolling-session KV prefix reuse, with a per-turn cache-hit panel.',
    tag: 'combs serve',
    needs: ['engine'],
  },
  debate: {
    title: 'Debate',
    owner: 'page',
    url: '/flows/debate.html',
    icon: '🗣',
    blurb: 'Agents argue a motion — each on its own named KV session. Chat-native history, anti-parrot sampling, per-turn cache stats.',
    tag: 'combs serve',
    needs: ['engine'],
  },
  'multi-turn': {
    title: 'Multi-turn (windowed)',
    owner: 'page',
    url: '/flows/multi-turn.html',
    icon: '🪟',
    blurb: 'Sliding-window context with a live preview of exactly what the model sees next. The windowed contrast to KV chat.',
    tag: 'combs serve',
    needs: ['engine'],
  },
  'emoji-studio': {
    title: 'Emoji Studio',
    // Standalone page hosted by server/emoji.ts; uses atoms/emoji + atoms/auth.
    owner: 'page',
    url: '/flows/emoji-studio.html',
    icon: '✨',
    blurb: 'Living CombsMesh emojis — persona chat, emotions/lifecycle/todos in the artifact, version chain with time-travel.',
    tag: 'server + mesh FFI',
    needs: ['server', 'emoji-host'],
  },
  pod: {
    title: 'Agent Pod',
    // Spawn-only page: opened by the agents page (🛰) into an isolated
    // origin; model bytes arrive via postMessage. Deep-linking shows the
    // isolation proof but no parent. Listed here so the launcher can
    // explain it — it renders as an info card, not a link.
    owner: 'page',
    url: '/flows/pod.html',
    spawnOnly: true,
    icon: '🛰',
    blurb: 'Origin-isolated agent runtime — own storage quota and heap per pod. Spawn one from the agents page 🛰 button.',
    tag: 'isolation',
    needs: ['server'],
  },
  'app-chat': {
    title: 'App Chat',
    owner: 'page',
    url: '/',
    icon: '💬',
    blurb: 'The main app: on-device LiteRT/MediaPipe models, vision+audio, agent runs with MCP tools.',
    tag: 'on-device',
    needs: [],
  },
  'agent-runs': {
    title: 'Agent Runs',
    loader: () => import('./agent-runs.js'),
  },
};

/** Known flow ids, for nav/menus. */
export function flowIds() {
  return Object.keys(flows);
}

/** Dynamically load a flow module (null for shell-owned flows). */
export async function loadFlow(id) {
  const flow = flows[id];
  if (!flow) throw new Error(`unknown flow: ${id}`);
  return flow.loader ? flow.loader() : null;
}
