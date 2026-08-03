// ============================================================
// Context budget for agent runs — deterministic message compaction.
// Both on-device providers replay history on every step, so the prompt
// must stay bounded: old tool outputs are truncated, only the latest
// image is kept, and the oldest middle messages are dropped under hard
// pressure (never splitting tool-call/tool-result pairs).
//
// The run keeps the FULL history for persistence/export — this module
// only computes the compacted view the model sees (inputs are never
// mutated). When the context is already small the input array is
// returned as-is (append-only), which keeps the LiteRT KV fast path
// viable.
// ============================================================

export const TAIL_MESSAGES = 6;        // verbatim tail (~2-3 steps)
export const TOOL_OUTPUT_CHARS = 200;  // truncation for old tool outputs
export const ASSISTANT_TEXT_CHARS = 300;
export const SOFT_CAP_CHARS = 8000;    // below this: return input unchanged
export const HARD_CAP_CHARS = 12000;   // above this: drop oldest middle msgs
const IMAGE_PLACEHOLDER = '[earlier image omitted]';

function isImageFilePart(part) {
  return part && part.type === 'file' && (part.mediaType || '').startsWith('image/');
}

function messageHasImage(msg) {
  if (msg.role === 'user') {
    return Array.isArray(msg.content) && msg.content.some(isImageFilePart);
  }
  if (msg.role === 'tool') {
    return msg.content.some(part =>
      part.type === 'tool-result' && part.output?.type === 'content'
      && (part.output.value || []).some(v => isImageFilePart(v) || v.type === 'image-data'));
  }
  return false;
}

// Rough size of a message for budgeting. Image data counts as a small
// placeholder — images are governed by the count policy, not chars.
function messageChars(msg) {
  let chars = 0;
  const countPart = (p) => {
    if (!p) return;
    if (p.type === 'text' || p.type === 'reasoning') chars += (p.text || '').length;
    else if (p.type === 'tool-call') chars += (p.toolName || '').length + JSON.stringify(p.input ?? {}).length;
    else if (p.type === 'tool-result') chars += outputChars(p.output);
    else if (isImageFilePart(p) || p.type === 'image-data') chars += 100;
    else chars += 50;
  };
  if (typeof msg.content === 'string') chars += msg.content.length;
  else if (Array.isArray(msg.content)) msg.content.forEach(countPart);
  return chars;
}

function outputChars(output) {
  if (!output) return 0;
  if (typeof output.value === 'string') return output.value.length;
  if (output.type === 'content') {
    return (output.value || []).reduce((n, v) =>
      n + (v.type === 'text' ? v.text.length : 100), 0);
  }
  try { return JSON.stringify(output.value ?? '').length; } catch { return 100; }
}

function measure(messages) {
  let chars = 0, images = 0;
  for (const m of messages) {
    chars += messageChars(m);
    if (messageHasImage(m)) images++;
  }
  return { chars, images };
}

const truncateText = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);

// Replace image parts with a text placeholder (user + tool messages).
function stripImages(msg) {
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map(p => isImageFilePart(p) ? { type: 'text', text: IMAGE_PLACEHOLDER } : p)
    };
  }
  if (msg.role === 'tool') {
    return {
      ...msg,
      content: msg.content.map(part => {
        if (part.type !== 'tool-result' || part.output?.type !== 'content') return part;
        return {
          ...part,
          output: {
            ...part.output,
            value: (part.output.value || []).map(v =>
              (isImageFilePart(v) || v.type === 'image-data') ? { type: 'text', text: IMAGE_PLACEHOLDER } : v)
          }
        };
      })
    };
  }
  return msg;
}

// Truncate old assistant texts and old tool outputs.
function truncateMessage(msg) {
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map(p =>
        p.type === 'text' ? { ...p, text: truncateText(p.text, ASSISTANT_TEXT_CHARS) } : p)
    };
  }
  if (msg.role === 'tool') {
    return {
      ...msg,
      content: msg.content.map(part => {
        if (part.type !== 'tool-result' || !part.output) return part;
        const output = part.output;
        if (typeof output.value === 'string') {
          return { ...part, output: { ...output, value: truncateText(output.value, TOOL_OUTPUT_CHARS) } };
        }
        if (output.type === 'content') {
          return {
            ...part,
            output: {
              ...output,
              value: (output.value || []).map(v =>
                v.type === 'text' ? { ...v, text: truncateText(v.text, TOOL_OUTPUT_CHARS) } : v)
            }
          };
        }
        return part;
      })
    };
  }
  return msg;
}

function hasToolCalls(msg) {
  return msg.role === 'assistant' && Array.isArray(msg.content)
    && msg.content.some(p => p.type === 'tool-call');
}

// Compact the model's view of the conversation. See header for the policy.
export function compactMessages(messages) {
  const stats = measure(messages);
  if (stats.chars <= SOFT_CAP_CHARS && stats.images <= 1) return messages;

  const n = messages.length;
  const tailStart = Math.max(1, n - TAIL_MESSAGES);
  const firstUserIndex = messages.findIndex(m => m.role === 'user');
  let lastImageIndex = -1;
  messages.forEach((m, i) => { if (messageHasImage(m)) lastImageIndex = i; });

  let out = messages.map((msg, i) => {
    let m = msg;
    if (i !== lastImageIndex && messageHasImage(m)) m = stripImages(m);
    const isKept = m.role === 'system' || i === firstUserIndex || i >= tailStart;
    if (!isKept) m = truncateMessage(m);
    return m;
  });

  // Hard cap: drop the oldest middle messages (after the first user
  // message), never the final message, never splitting a tool call from
  // its results, and never dropping the latest image (it's likely the
  // agent's most relevant context).
  const imgIdx = out.findIndex(m => messageHasImage(m));
  const protectedMsgs = new Set();
  if (imgIdx !== -1) {
    protectedMsgs.add(out[imgIdx]);
    if (imgIdx > 0 && hasToolCalls(out[imgIdx - 1])) protectedMsgs.add(out[imgIdx - 1]);
  }
  let chars = measure(out).chars;
  let start = (firstUserIndex === -1 ? 0 : firstUserIndex) + 1;
  let guard = out.length * 3 + 10;
  while (chars > HARD_CAP_CHARS && start < out.length - 1 && guard-- > 0) {
    const msg = out[start];
    if (protectedMsgs.has(msg)) { start++; continue; }
    if (hasToolCalls(msg)) {
      // Drop the assistant call and its tool-result message(s) together.
      let end = Math.min(start + 1, out.length - 1);
      while (end < out.length - 1 && out[end].role === 'tool' && !protectedMsgs.has(out[end])) end++;
      out = [...out.slice(0, start), ...out.slice(end)];
    } else {
      out = [...out.slice(0, start), ...out.slice(start + 1)];
    }
    chars = measure(out).chars;
  }
  return out;
}
