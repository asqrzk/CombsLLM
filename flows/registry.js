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
 */
export const flows = {
  chat: {
    title: 'Chat',
    owner: 'shell', // app.js — extraction to flows/chat.js is future work
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
