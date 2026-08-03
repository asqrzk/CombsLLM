// ============================================================
// Pure text helpers — no DOM, no state.
// ============================================================

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Textual view of a message content (string or multimodal part array).
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join(' ');
  return '';
}

export function formatBytes(bytes) {
  if (bytes == null) return 'N/A';
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// Pull <think>…</think> reasoning blocks out of the visible reply.
export function extractThinking(text) {
  const blocks = [];
  let rest = String(text);
  rest = rest.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => { blocks.push(inner.trim()); return ''; });
  const openIdx = rest.search(/<think>/i);
  if (openIdx !== -1) {
    blocks.push(rest.slice(openIdx + 7).trim());
    rest = rest.slice(0, openIdx);
  }
  return { thinking: blocks, visible: rest };
}

export function deriveTitle(log) {
  const firstUser = log.find(m => m.role === 'user');
  if (!firstUser) return 'New chat';
  let t = contentToText(firstUser.content).replace(/\[Image:[^\]]*\]/g, '').trim();
  if (!t) t = 'Media chat';
  return t.length > 48 ? t.slice(0, 48).trimEnd() + '…' : t;
}

// Rough token estimate used by the context meter and pruning.
export function estimateMessageTokens(msg) {
  let tokens = 0;
  if (typeof msg.content === 'string') {
    tokens += Math.ceil(msg.content.split(/\s+/).length * 1.3);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') tokens += Math.ceil(part.text.split(/\s+/).length * 1.3);
      else if (part.type === 'image') tokens += 512;
      else if (part.type === 'audio') tokens += Math.ceil((part.duration || 8) * 32);
    }
  }
  return tokens;
}

// Caveman compression: drop stop words to shrink the replayed context.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into',
  'it', "it's", 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'and', 'but', 'or', 'as', 'if', 'when', 'than', 'because', 'while',
  'me', 'my', 'mine', 'we', 'our', 'ours', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them'
]);

export function compressToCaveman(text) {
  if (typeof text !== 'string') return text;
  return text.split(/\s+/).filter(word => {
    const cleanWord = word.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?'"]/g, '');
    return !STOP_WORDS.has(cleanWord) && cleanWord.length > 0;
  }).join(' ');
}
