// ============================================================
// Chat rendering: markdown pipeline, message bubbles, scroll state.
// ============================================================
import { chatBox, chatScroll, chatEmpty, headerTitle, reasoningToggle } from './dom.js';
import { state } from './state.js';
import { escapeHtml, extractThinking, contentToText, deriveTitle } from './text.js';
import { getModelName } from './config.js';
import { toast } from './ui.js';

if (window.marked) marked.setOptions({ gfm: true, breaks: true });

function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    pre.appendChild(btn);
  });
}

export function renderMarkdownInto(container, rawText, { streaming = false } = {}) {
  const { thinking, visible } = extractThinking(rawText);
  let html = '';
  if (reasoningToggle.checked) {
    for (const t of thinking) {
      html += `<details class="thinking-block"><summary>Thinking</summary><div>${escapeHtml(t)}</div></details>`;
    }
  }

  // Vault LaTeX before markdown parsing so _, ^, \ survive intact.
  const mathVault = [];
  const vaultKey = (i) => `⦅COMBSLLM_MATH_${i}⦆`;
  let protectedText = visible || '';

  protectedText = protectedText.replace(/\$\$([\s\S]*?)\$\$/g, (match, math) => {
    const i = mathVault.length;
    mathVault.push({ type: 'display', math: math.trim() });
    return vaultKey(i);
  });
  protectedText = protectedText.replace(/\$([^\$\s][^\$]*?)\$/g, (match, math) => {
    const i = mathVault.length;
    mathVault.push({ type: 'inline', math: math.trim() });
    return vaultKey(i);
  });

  let parsed = window.marked ? marked.parse(protectedText) : escapeHtml(protectedText).replace(/\n/g, '<br>');
  const sanitized = window.DOMPurify ? DOMPurify.sanitize(parsed) : parsed;

  html += sanitized.replace(/⦅COMBSLLM_MATH_(\d+)⦆/g, (match, idx) => {
    const item = mathVault[idx];
    if (!item) return match;
    if (window.katex) {
      try {
        return katex.renderToString(item.math, { throwOnError: false, displayMode: item.type === 'display' });
      } catch (e) {
        console.warn('KaTeX render failed:', e);
      }
    }
    return item.type === 'display' ? `$$${item.math}$$` : `$${item.math}$`;
  });

  container.innerHTML = html;
  addCopyButtons(container);
  if (streaming) {
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';
    container.appendChild(cursor);
  }
}

chatBox.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-copy-btn');
  if (!btn) return;
  const code = btn.parentElement.querySelector('code');
  navigator.clipboard.writeText(code ? code.innerText : '').then(() => {
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }).catch(() => toast('Clipboard unavailable', 'warning', 2500));
});

export function syncEmptyState() {
  chatEmpty.classList.toggle('visible', state.activeMessagesLog.filter(m => m.role !== 'system').length === 0);
}

export function scrollChatToBottom(force = false) {
  const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 120;
  if (force || nearBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
}

export function addUserBubble(text, { image = null, audio = null } = {}) {
  const div = document.createElement('div');
  div.className = 'message user';
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'You';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (image) {
    const img = document.createElement('img');
    img.src = image;
    img.alt = 'Attached image';
    img.className = 'chat-image';
    img.loading = 'lazy';
    bubble.appendChild(img);
  }
  if (audio) {
    const player = document.createElement('audio');
    player.controls = true;
    player.src = audio;
    player.className = 'chat-audio';
    bubble.appendChild(player);
  }
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    bubble.appendChild(span);
  }
  div.append(label, bubble);
  chatBox.appendChild(div);
  syncEmptyState();
  scrollChatToBottom(true);
}

export function addAiMessageShell(modelName = '') {
  const div = document.createElement('div');
  div.className = 'message ai';
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'AI';
  if (modelName) {
    const badge = document.createElement('span');
    badge.className = 'model-badge';
    badge.textContent = modelName;
    label.appendChild(badge);
  }
  const content = document.createElement('div');
  content.className = 'markdown-content';
  const metrics = document.createElement('div');
  metrics.className = 'message-metrics';
  div.append(label, content, metrics);
  chatBox.appendChild(div);
  syncEmptyState();
  scrollChatToBottom(true);
  return { label, content, metrics };
}

export function renderAllMessages() {
  chatBox.querySelectorAll('.message').forEach(m => m.remove());
  const chatModel = state.activeChatModel || state.currentModel || '';
  for (const msg of state.activeMessagesLog) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      addUserBubble(contentToText(msg.content), {
        image: parts.find(p => p.type === 'image')?.dataUrl || null,
        audio: parts.find(p => p.type === 'audio')?.dataUrl || null
      });
    } else {
      const { content, metrics } = addAiMessageShell(getModelName(chatModel));
      renderMarkdownInto(content, contentToText(msg.content));
      if (msg.metrics) {
        metrics.textContent = `~${msg.metrics.tokPerSec} tok/s · ${msg.metrics.secs}s`;
      }
    }
  }
  syncEmptyState();
  headerTitle.textContent = state.activeMessagesLog.some(m => m.role === 'user')
    ? deriveTitle(state.activeMessagesLog)
    : 'New chat';
  scrollChatToBottom(true);
}
