// ============================================================
// combs-remote backend — a `combs serve` (CombsEngine) instance over
// its OpenAI-compatible HTTP API. Unlike the on-device backends there
// is no download/mount cost; unlike the AI-SDK adapters, KV cache IS
// reused: we pin a `session_id` per mount, so the engine's rolling
// session rolls back to the longest common prefix and prefills only
// the suffix (surfaced as usage.prompt_tokens_details.cached_tokens).
//
// The SSE parser keeps the final `usage` chunk — the npm combs-client
// drops it, so this vendored parser is the usage-keeping fork (upstream
// candidate for combs-client, tracked in the platform plan).
// ============================================================

const LS_URL = 'combsllm.combsEngineUrl';
const LS_TOKEN = 'combsllm.combsEngineToken';
const DEFAULT_URL = 'http://localhost:8080';

export function combsEngineUrl() {
  return (localStorage.getItem(LS_URL) || DEFAULT_URL).replace(/\/+$/, '');
}
export function setCombsEngineUrl(url) {
  localStorage.setItem(LS_URL, url.replace(/\/+$/, ''));
}
export function combsEngineToken() {
  return localStorage.getItem(LS_TOKEN) || '';
}
export function setCombsEngineToken(token) {
  localStorage.setItem(LS_TOKEN, token);
}

// Map the app's message log to OpenAI chat messages. Media parts become
// text placeholders — remote text models can't see them (vision models
// served by combs serve get real image parts in a later increment).
function toOpenAiMessages(history) {
  return history.map((msg) => {
    if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
    const text = (msg.content || []).map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image') return `[Image: ${part.name || 'attachment'}]`;
      if (part.type === 'audio') return '[Audio attachment]';
      return '';
    }).filter(Boolean).join('\n');
    return { role: msg.role, content: text };
  });
}

export class CombsRemoteBackend {
  constructor() {
    this.kind = 'combs';
    this.baseUrl = DEFAULT_URL;
    this.sessionId = null;
    this.lastUsage = null; // {prompt_tokens, completion_tokens, cached_tokens}
    this.abort = null;
  }

  // No artifact to mount — just remember the endpoint and probe /health.
  async mount(_modelDef, _blobUrl, { engineUrl } = {}) {
    this.baseUrl = (engineUrl || combsEngineUrl()).replace(/\/+$/, '');
    const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers() });
    if (!res.ok) throw new Error(`combs serve unreachable at ${this.baseUrl} (HTTP ${res.status})`);
    // One named session per mount — the engine rolls back to the longest
    // common token prefix on every request, so replayed/pruned histories
    // are handled server-side.
    this.sessionId = `combsllm-${crypto.randomUUID().slice(0, 8)}`;
    this.lastUsage = null;
  }

  headers() {
    const token = combsEngineToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  // Server-side session holds the KV; nothing to rebuild client-side.
  async resetContext() {}

  async send(_content, { history = [] } = {}, onText) {
    this.abort = new AbortController();
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify({
        model: 'default',
        messages: toOpenAiMessages(history),
        stream: true,
        session_id: this.sessionId,
        temperature: 0.7,
        frequency_penalty: 0.5,
        max_tokens: 512,
      }),
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`combs serve HTTP ${res.status}`);
    }

    // Usage-keeping SSE parse: delta chunks carry content; the final
    // chunk (finish_reason) carries `usage`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamed = '';
    let usage = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop(); // trailing partial event
      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) { streamed += delta; onText(delta); }
            if (json.usage) usage = json.usage;
          } catch { /* ignore keep-alives / partials */ }
        }
      }
    }

    this.lastUsage = usage && {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    };
    return streamed;
  }

  async dispose() {
    if (this.abort) { this.abort.abort(); this.abort = null; }
    this.sessionId = null;
    this.lastUsage = null;
  }
}
