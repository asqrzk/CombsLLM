// ============================================================
// engine atom — shared client for a `combs serve` instance.
//
// streamChatWithUsage is the usage-keeping SSE client: the final chunk
// carries `usage` (incl. prompt_tokens_details.cached_tokens), which
// the npm combs-client drops. All flow pages (kv-chat, debate,
// multi-turn) share this one implementation.
//
// Traffic goes through the permission relay (scope net:combs-engine)
// when server-hosted; direct fetch when static.
// ============================================================

import { relayFetch } from '../relay/index.js';
import { combsEngineUrl } from '../backends/combs-remote.js';

export function engineBase() {
  return combsEngineUrl();
}

/**
 * Stream a chat completion, keeping usage.
 *   await streamChatWithUsage(server, messages, opts, cb, signal)
 * opts: { model, maxTokens, temperature, frequencyPenalty, presencePenalty, sessionId }
 * cb:   { onDelta(text), onUsage(usage), onDone(finishReason), onError(err) }
 * server defaults to the configured engine URL; pass '' to use it.
 */
export async function streamChatWithUsage(server, messages, opts = {}, cb = {}, signal) {
  const base = (server || combsEngineUrl()).replace(/\/+$/, '');
  try {
    const res = await relayFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      scope: 'net:combs-engine',
      detail: `Chat completion via the Combs engine at ${base}`,
      body: JSON.stringify({
        messages,
        model: opts.model ?? 'default',
        max_tokens: opts.maxTokens ?? 256,
        temperature: opts.temperature ?? 0.7,
        ...(opts.frequencyPenalty != null && { frequency_penalty: opts.frequencyPenalty }),
        ...(opts.presencePenalty != null && { presence_penalty: opts.presencePenalty }),
        ...(opts.sessionId && { session_id: opts.sessionId }),
        stream: true,
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`engine HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { cb.onDone?.('stop'); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          if (parsed.error) throw new Error(parsed.error.message || String(parsed.error));
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) cb.onDelta?.(delta);
          if (parsed.usage) cb.onUsage?.(parsed.usage);
          const finish = parsed.choices?.[0]?.finish_reason;
          if (finish) { cb.onDone?.(finish); return; }
        }
      }
    }
    cb.onDone?.('stop'); // EOF without finish_reason
  } catch (e) {
    cb.onError?.(e);
  }
}
