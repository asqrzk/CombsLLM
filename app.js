import { Engine } from 'https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm';

// ============================================================
// DOM Bindings
// ============================================================
const $ = (id) => document.getElementById(id);
const app = $('app');
const chatBox = $('chat-box');
const chatScroll = $('chat-scroll');
const chatEmpty = $('chat-empty');
const inputField = $('prompt-input');
const sendBtn = $('send-btn');
const loadBtn = $('load-btn');
const attachBtn = $('attach-btn');
const imageUpload = $('image-upload');
const attachChip = $('attach-chip');
const attachChipName = $('attach-chip-name');
const attachChipRemove = $('attach-chip-remove');
const compressBtn = $('compress-btn');
const clearCacheBtn = $('clear-cache-btn');
const contextLimitInput = $('context-limit');
const cavemanToggle = $('caveman-toggle');
const reasoningToggle = $('reasoning-toggle');
const menuBtn = $('menu-btn');
const sidebarBackdrop = $('sidebar-backdrop');
const sidebarCloseBtn = $('sidebar-close-btn');
const newChatBtn = $('new-chat-btn');
const chatListEl = $('chat-list');
const headerTitle = $('header-title');
const engineStatus = $('engine-status');
const engineStatusText = $('engine-status-text');
const toggleConsoleBtn = $('toggle-console-btn');
const consolePanel = $('console-panel');
const toastContainer = $('toast-container');
const sidebarStorageTxt = $('sidebar-storage-txt');
const confirmModal = $('confirm-modal');
const confirmModalTitle = $('confirm-modal-title');
const confirmModalBody = $('confirm-modal-body');
const confirmModalClose = $('confirm-modal-close');
const confirmModalCancel = $('confirm-modal-cancel');
const confirmModalConfirm = $('confirm-modal-confirm');
let confirmModalResolve = null;

const storageModal = $('storage-modal');
const storageModalBody = $('storage-modal-body');
const storageModalClose = $('storage-modal-close');
const storageModalDone = $('storage-modal-done');
const storageModalPurge = $('storage-modal-purge');

// ============================================================
// State
// ============================================================
let engine = null;
let conversation = null;
let activeMessagesLog = [];
let activeChatId = null;
let activeChatModel = null;
let currentModel = null;
let generating = false;
let pruning = false;
let isRestoring = false;
const SYSTEM_PREFACE = "You are a hardware-constrained AI assistant. Respond accurately.";
const MODEL_NAMES = {
  'gemma-4-E2B-it-web': 'Gemma 4 E2B',
  'gemma-4-E4B-it-web': 'Gemma 4 E4B'
};

function getSelectedModel() {
  return $('model-select').value;
}

function getModelName(modelId) {
  return MODEL_NAMES[modelId] || modelId;
}

function syncModelSelect(modelId) {
  if (modelId && $('model-select').value !== modelId) {
    $('model-select').value = modelId;
  }
}

// ============================================================
// 0. TOAST NOTIFICATIONS  (replaces inline system messages)
// ============================================================
const TOAST_ICONS = {
  info: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  warning: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  error: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>'
};

function toast(message, type = 'info', duration = 4200) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <div class="toast-body"></div>
    <button class="toast-close" aria-label="Dismiss">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>`;
  el.querySelector('.toast-body').textContent = message;
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  const dismiss = () => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 220);
  };
  const timer = setTimeout(dismiss, duration);
  el.querySelector('.toast-close').addEventListener('click', () => { clearTimeout(timer); dismiss(); });

  while (toastContainer.children.length > 4) toastContainer.firstChild.remove();
}

function showConfirmModal({ title = 'Confirm', message = 'Are you sure?', confirmText = 'Delete', onConfirm }) {
  confirmModalTitle.textContent = title;
  confirmModalBody.textContent = message;
  confirmModalConfirm.textContent = confirmText;
  confirmModalResolve = onConfirm;
  confirmModal.classList.remove('hidden');
}

function hideConfirmModal() {
  confirmModal.classList.add('hidden');
  confirmModalResolve = null;
}

// ============================================================
// 0b. MARKDOWN RENDERING (marked + DOMPurify, stream-safe)
// ============================================================
if (window.marked) marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Pull <think>…</think> reasoning blocks out of the visible reply
function extractThinking(text) {
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

function renderMarkdownInto(container, rawText, { streaming = false } = {}) {
  const { thinking, visible } = extractThinking(rawText);
  let html = '';
  if (reasoningToggle.checked) {
    for (const t of thinking) {
      html += `<details class="thinking-block"><summary>Thinking</summary><div>${escapeHtml(t)}</div></details>`;
    }
  }

  // Extract LaTeX math before markdown parsing so _, ^, \ etc. survive intact.
  const mathVault = [];
  const vaultKey = (i) => `⦅COMBSLLM_MATH_${i}⦆`;
  let protectedText = visible || '';

  // Display math: $$ ... $$
  protectedText = protectedText.replace(/\$\$([\s\S]*?)\$\$/g, (match, math) => {
    const i = mathVault.length;
    mathVault.push({ type: 'display', math: math.trim() });
    return vaultKey(i);
  });

  // Inline math: $ ... $  (avoid lone $/currency by requiring non-$ content)
  protectedText = protectedText.replace(/\$([^\$\s][^\$]*?)\$/g, (match, math) => {
    const i = mathVault.length;
    mathVault.push({ type: 'inline', math: math.trim() });
    return vaultKey(i);
  });

  let parsed = window.marked ? marked.parse(protectedText) : escapeHtml(protectedText).replace(/\n/g, '<br>');
  const sanitized = window.DOMPurify ? DOMPurify.sanitize(parsed) : parsed;

  // Restore math placeholders as KaTeX-rendered HTML.
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

// ============================================================
// 1. INDEXEDDB CHAT STORE
// ============================================================
const DB_NAME = 'combsllm-chats';
const STORE = 'chats';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ============================================================
// 2. CHAT SESSION MANAGEMENT
// ============================================================
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join(' ');
  return '';
}

function formatBytes(bytes) {
  if (bytes == null) return 'N/A';
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function deriveTitle(log) {
  const firstUser = log.find(m => m.role === 'user');
  if (!firstUser) return 'New chat';
  let t = contentToText(firstUser.content).replace(/\[Image:[^\]]*\]/g, '').trim();
  if (!t) t = 'Image chat';
  return t.length > 48 ? t.slice(0, 48).trimEnd() + '…' : t;
}

async function persistActiveChat() {
  if (isRestoring) return;
  if (!activeMessagesLog.some(m => m.role === 'user')) return;
  try {
    const now = Date.now();
    if (!activeChatId) activeChatId = crypto.randomUUID();
    const existing = await idbGet(activeChatId);
    await idbPut({
      id: activeChatId,
      title: deriveTitle(activeMessagesLog),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      model: activeChatModel || currentModel || getSelectedModel(),
      messages: activeMessagesLog
    });
    localStorage.setItem('combsllm.activeChatId', activeChatId);
    headerTitle.textContent = deriveTitle(activeMessagesLog);
    await refreshSidebar();
  } catch (err) {
    console.warn('Chat persistence failed:', err);
  }
}

async function refreshSidebar() {
  let chats = [];
  try { chats = await idbGetAll(); } catch (e) { console.warn(e); }
  chatListEl.innerHTML = '';
  if (!chats.length) {
    chatListEl.innerHTML = '<div class="chat-list-empty">No saved chats yet.<br>Start typing — chats save automatically.</div>';
    return;
  }
  const label = document.createElement('div');
  label.className = 'chat-list-label';
  label.textContent = 'Recent chats';
  chatListEl.appendChild(label);

  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === activeChatId ? ' active' : '');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
      <span class="chat-item-title">${escapeHtml(c.title)}</span>
      <button class="chat-item-delete" aria-label="Delete chat" title="Delete chat">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.chat-item-delete')) return;
      openChat(c.id);
    });
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') openChat(c.id); });
    item.querySelector('.chat-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirmModal({
        title: 'Delete chat',
        message: `Delete "${c.title}"? This cannot be undone.`,
        confirmText: 'Delete',
        onConfirm: async () => {
          await idbDelete(c.id);
          toast('Chat deleted', 'info', 2500);
          if (c.id === activeChatId) await startNewChat(false);
          await refreshSidebar();
          hideConfirmModal();
        }
      });
    });
    chatListEl.appendChild(item);
  }
}

function syncEmptyState() {
  chatEmpty.classList.toggle('visible', activeMessagesLog.filter(m => m.role !== 'system').length === 0);
}

function scrollChatToBottom(force = false) {
  const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 120;
  if (force || nearBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
}

function addUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'message user';
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'You';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  div.append(label, bubble);
  chatBox.appendChild(div);
  syncEmptyState();
  scrollChatToBottom(true);
}

function addAiMessageShell(modelName = '') {
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

function renderAllMessages() {
  chatBox.querySelectorAll('.message').forEach(m => m.remove());
  const chatModel = activeChatModel || currentModel || getSelectedModel();
  for (const msg of activeMessagesLog) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      addUserBubble(contentToText(msg.content));
    } else {
      const { content, metrics } = addAiMessageShell(getModelName(chatModel));
      renderMarkdownInto(content, contentToText(msg.content));
      if (msg.metrics) {
        metrics.textContent = `~${msg.metrics.tokPerSec} tok/s · ${msg.metrics.secs}s`;
      }
    }
  }
  syncEmptyState();
  headerTitle.textContent = activeMessagesLog.some(m => m.role === 'user') ? deriveTitle(activeMessagesLog) : 'New chat';
  scrollChatToBottom(true);
}

async function rebuildEngineConversation() {
  if (!engine) return;
  if (conversation) await conversation.delete();
  const useCaveman = cavemanToggle.checked;
  // Ensure the system preface is present so restored context keeps the persona.
  const messages = activeMessagesLog.some(m => m.role === 'system')
    ? activeMessagesLog
    : [{ role: 'system', content: SYSTEM_PREFACE }, ...activeMessagesLog];
  // Rebuild the entire context in one shot via the conversation preface.
  // This avoids generating responses for historical turns and keeps the
  // conversation free for the user's next message.
  conversation = await engine.createConversation({
    preface: {
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.role === 'system'
          ? msg.content
          : preparePayload(msg.content, useCaveman)
      }))
    }
  });
}

async function startNewChat(focusInput = true) {
  if (generating) { toast('Wait for the current reply to finish.', 'warning', 2600); return; }
  activeChatId = null;
  activeChatModel = null;
  activeMessagesLog = [{ role: 'system', content: SYSTEM_PREFACE }];
  syncModelSelect(currentModel || getSelectedModel());
  localStorage.removeItem('combsllm.activeChatId');
  chatBox.querySelectorAll('.message').forEach(m => m.remove());
  syncEmptyState();
  headerTitle.textContent = 'New chat';
  await refreshSidebar();
  closeMobileSidebar();
  if (engine) {
    try {
      await conversation.delete();
      conversation = await engine.createConversation({
        preface: { messages: [{ role: 'system', content: SYSTEM_PREFACE }] }
      });
    } catch (e) { console.warn(e); }
  }
  updateMetricsDashboard();
  if (focusInput && !inputField.disabled) inputField.focus();
}

async function openChat(id) {
  if (id === activeChatId) { closeMobileSidebar(); return; }
  if (generating) { toast('Wait for the current reply to finish.', 'warning', 2600); return; }
  isRestoring = true;
  let chat;
  try { chat = await idbGet(id); } catch (e) { chat = null; }
  if (!chat) { isRestoring = false; toast('Could not load chat', 'error'); return; }

  activeChatId = id;
  activeMessagesLog = chat.messages || [];
  activeChatModel = chat.model || null;
  if (activeChatModel) syncModelSelect(activeChatModel);
  localStorage.setItem('combsllm.activeChatId', id);
  renderAllMessages();
  await refreshSidebar();
  isRestoring = false;
  closeMobileSidebar();
  updateMetricsDashboard();

  if (engine && activeMessagesLog.some(m => m.role === 'user')) {
    if (activeChatModel && currentModel && currentModel !== activeChatModel) {
      // Swap to the model this conversation was created with.
      await initModel();
    } else {
      toast('Replaying chat into engine context…', 'info', 2500);
      try {
        await rebuildEngineConversation();
        toast('Chat restored — context ready', 'success', 2600);
      } catch (e) {
        toast('Context restore failed: ' + e.message, 'error');
      }
    }
  } else if (!engine) {
    toast('Chat loaded. Initialize the engine to continue it.', 'info', 3200);
  }
}

// ============================================================
// 3. SIDEBAR / LAYOUT BEHAVIOR
// ============================================================
const desktopMQ = window.matchMedia('(min-width: 769px)');

function toggleSidebar() {
  if (desktopMQ.matches) app.classList.toggle('sidebar-collapsed');
  else app.classList.toggle('sidebar-open');
}
function closeMobileSidebar() { app.classList.remove('sidebar-open'); }

menuBtn.addEventListener('click', toggleSidebar);
sidebarCloseBtn.addEventListener('click', closeMobileSidebar);
sidebarBackdrop.addEventListener('click', closeMobileSidebar);
desktopMQ.addEventListener('change', () => app.classList.remove('sidebar-open', 'sidebar-collapsed'));

toggleConsoleBtn.addEventListener('click', () => {
  const collapsed = consolePanel.classList.toggle('collapsed');
  toggleConsoleBtn.classList.toggle('active', !collapsed);
  localStorage.setItem('combsllm.consoleCollapsed', collapsed ? '1' : '0');
});

// ============================================================
// 4. HARDWARE & STORAGE MONITORING
// ============================================================
async function updateMetricsDashboard() {
  if (performance.memory) {
    const usedHeap = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
    const totalHeap = (performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(1);
    $('js-heap-txt').innerText = `${usedHeap} MB / ${totalHeap} MB`;
  }

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const used = formatBytes(estimate.usage);
      $('disk-usage-txt').innerText = `${used} utilized`;
      sidebarStorageTxt.textContent = `${used} stored locally`;
    } catch (e) { /* ignore */ }
  }

  let estimatedTokens = 0;
  activeMessagesLog.forEach(msg => {
    if (typeof msg.content === 'string') {
      estimatedTokens += Math.ceil(msg.content.split(/\s+/).length * 1.3);
    } else if (Array.isArray(msg.content)) {
      msg.content.forEach(part => {
        if (part.type === 'text') estimatedTokens += Math.ceil(part.text.split(/\s+/).length * 1.3);
        if (part.type === 'image') estimatedTokens += 512;
      });
    }
  });

  const maxThreshold = parseInt(contextLimitInput.value) || 32000;
  $('kv-cache-txt').innerText = `${estimatedTokens} / ${maxThreshold} est. tokens`;

  const percentage = Math.min((estimatedTokens / maxThreshold) * 100, 100);
  const progressBar = $('context-progress');
  progressBar.style.width = `${percentage}%`;
  progressBar.className = 'progress-fill';
  if (percentage > 85) progressBar.classList.add('danger');
  else if (percentage > 60) progressBar.classList.add('warning');

  if (estimatedTokens > maxThreshold && engine && !pruning && !generating) {
    toast('Context boundary breached — compressing memory automatically.', 'warning');
    await executeContextPruning();
  }
}

// ============================================================
// 5. CAVEMAN COMPRESSION ENGINE
// ============================================================
function compressToCaveman(text) {
  if (typeof text !== 'string') return text;
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into',
    'it', "it's", 'its', 'this', 'that', 'these', 'those', 'there', 'here',
    'and', 'but', 'or', 'as', 'if', 'when', 'than', 'because', 'while',
    'me', 'my', 'mine', 'we', 'our', 'ours', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them'
  ]);
  return text.split(/\s+/).filter(word => {
    const cleanWord = word.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?'"]/g, "");
    return !stopWords.has(cleanWord) && cleanWord.length > 0;
  }).join(' ');
}

function preparePayload(content, applyCaveman) {
  if (!applyCaveman) return content;
  if (typeof content === 'string') return compressToCaveman(content);
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return { ...part, text: compressToCaveman(part.text) };
      return part;
    });
  }
  return content;
}

// ============================================================
// 6. CONTEXT & STATE MANAGEMENT
// ============================================================
async function executeContextPruning() {
  if (!engine) { toast('Initialize the engine first.', 'warning', 2600); return; }
  if (pruning) return;
  pruning = true;
  const maxThreshold = parseInt(contextLimitInput.value) || 2048;
  toast('Compressing KV cache — truncating older entries…', 'info', 3000);

  while (activeMessagesLog.length > 2) {
    const idx = activeMessagesLog.findIndex(m => m.role !== 'system');
    if (idx === -1) break;
    activeMessagesLog.splice(idx, 1);
    let currentEst = activeMessagesLog.reduce((acc, current) => {
      const textVal = typeof current.content === 'string' ? current.content : JSON.stringify(current.content);
      return acc + Math.ceil(textVal.split(/\s+/).length * 1.3);
    }, 0);
    if (currentEst <= maxThreshold * 0.7) break;
  }

  try {
    await rebuildEngineConversation();
    renderAllMessages();
    await persistActiveChat();
    toast('Context compression complete.', 'success', 2600);
  } catch (e) {
    toast('Compression failed: ' + e.message, 'error');
  }
  pruning = false;
  await updateMetricsDashboard();
}

function cacheUrlToName(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() || url;
    return filename.replace('.litertlm', '').replace(/-/g, ' ');
  } catch {
    return url;
  }
}

async function getCacheItems() {
  if (!window.caches) return [];
  const items = [];
  const cacheNames = await caches.keys();
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    for (const request of requests) {
      const url = typeof request === 'string' ? request : request.url;
      let size = null;
      try {
        const response = await cache.match(request);
        if (response) {
          const blob = await response.blob();
          size = blob.size;
        }
      } catch (e) { /* ignore */ }
      items.push({ cacheName: name, url, name: cacheUrlToName(url), size });
    }
  }
  return items;
}

async function deleteCacheItem(cacheName, url) {
  try {
    const cache = await caches.open(cacheName);
    await cache.delete(url);
    toast('Model removed from cache.', 'success', 2600);
  } catch (e) {
    toast('Failed to remove model: ' + e.message, 'error');
  }
  await renderStorageList();
  await updateMetricsDashboard();
}

async function renderStorageList() {
  const items = await getCacheItems();
  storageModalBody.innerHTML = '';
  if (!items.length) {
    storageModalBody.innerHTML = '<div class="storage-list-empty">No cached models found.</div>';
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'storage-item';
    row.innerHTML = `
      <span class="storage-item-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/></svg>
      </span>
      <div class="storage-item-info">
        <div class="storage-item-name">${escapeHtml(item.name)}</div>
        <div class="storage-item-size">${item.size != null ? formatBytes(item.size) : 'Size unknown'}</div>
      </div>
      <button type="button" class="storage-item-delete" aria-label="Delete ${escapeHtml(item.name)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`;
    row.querySelector('.storage-item-delete').addEventListener('click', () => deleteCacheItem(item.cacheName, item.url));
    storageModalBody.appendChild(row);
  }
}

function openStorageModal() {
  renderStorageList();
  storageModal.classList.remove('hidden');
}

function closeStorageModal() {
  storageModal.classList.add('hidden');
}

async function purgeAllStorage() {
  showConfirmModal({
    title: 'Purge all storage',
    message: 'Delete every downloaded model and engine cache? Your saved chats will be kept.',
    confirmText: 'Purge all',
    onConfirm: async () => {
      try {
        if (window.caches) {
          const keys = await caches.keys();
          for (const key of keys) { await caches.delete(key); }
        }
        if (indexedDB.databases) {
          const dbs = await indexedDB.databases();
          for (const db of dbs) {
            if (db.name && db.name !== DB_NAME) indexedDB.deleteDatabase(db.name);
          }
        }
        hideConfirmModal();
        closeStorageModal();
        toast('Model cache purged. Chat history preserved — reloading…', 'success', 2200);
        setTimeout(() => window.location.reload(), 1400);
      } catch (e) {
        toast('Purge failed: ' + e.message, 'error');
      }
    }
  });
}

// ============================================================
// 7. WEBGPU ENGINE & EXPLICIT CACHING
// ============================================================
function setEngineStatus(state, text) {
  engineStatus.classList.remove('loading', 'ready');
  loadBtn.classList.remove('loading', 'ready');
  if (state) {
    engineStatus.classList.add(state);
    loadBtn.classList.add(state);
  }
  engineStatusText.textContent = text;
}

async function fetchAndCacheModel(modelUrl) {
  const cacheName = 'litert-models-v1';
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(modelUrl);

  if (cachedResponse) {
    toast('Model found in local cache — loading instantly from disk.', 'info', 3000);
    const blob = await cachedResponse.blob();
    return URL.createObjectURL(blob);
  }

  toast('Model not cached. Downloading from Hugging Face…', 'info', 3500);
  const downloadUI = $('download-ui');
  const statusTxt = $('download-status');
  const percentTxt = $('download-percent');
  const progressBar = $('download-progress');

  downloadUI.classList.add('visible');

  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

  const contentLength = response.headers.get('content-length');
  const totalBytes = parseInt(contentLength, 10);
  let loadedBytes = 0;

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        loadedBytes += value.byteLength;
        if (totalBytes) {
          const percent = Math.round((loadedBytes / totalBytes) * 100);
          percentTxt.innerText = `${percent}%`;
          progressBar.style.width = `${percent}%`;
          statusTxt.innerText = `Downloading: ${(loadedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`;
        }
        controller.enqueue(value);
      }
      controller.close();
    }
  });

  const newResponse = new Response(stream, { headers: response.headers });
  const blob = await newResponse.clone().blob();
  await cache.put(modelUrl, newResponse);

  downloadUI.classList.remove('visible');
  toast('Download complete — model cached on this device.', 'success', 3200);
  return URL.createObjectURL(blob);
}

async function offloadEngine() {
  if (!engine) return;
  loadBtn.disabled = true;
  $('model-select').disabled = false;
  setEngineStatus('', 'Idle');
  try {
    if (conversation) await conversation.delete();
    await engine.delete();
  } catch (e) {
    console.warn('Engine offload error:', e);
  }
  engine = null;
  conversation = null;
  currentModel = null;
  inputField.disabled = true;
  attachBtn.disabled = true;
  compressBtn.disabled = true;
  inputField.placeholder = 'Initialize the engine to begin…';
  loadBtn.textContent = 'Initialize engine';
  loadBtn.disabled = false;
  syncSendState();
  toast('Engine offloaded.', 'info', 2600);
}

async function initModel() {
  loadBtn.disabled = true;
  $('model-select').disabled = true;
  loadBtn.textContent = 'Initializing…';
  setEngineStatus('loading', 'Loading');
  const modelName = getSelectedModel();
  const remoteModelUrl = `https://huggingface.co/litert-community/${modelName.replace('-web', '-litert-lm')}/resolve/main/${modelName}.litertlm`;

  try {
    if (engine) {
      if (conversation) {
        await conversation.delete();
        conversation = null;
      }
      await engine.delete();
    }

    const localBlobUrl = await fetchAndCacheModel(remoteModelUrl);

    toast(`Mounting engine for ${modelName}…`, 'info', 2800);

    engine = await Engine.create({
      model: localBlobUrl,
      mainExecutorSettings: { maxNumTokens: 8192 }
    });

    currentModel = modelName;
    if (activeChatModel === null) activeChatModel = currentModel;
    else if (activeChatModel !== currentModel) activeChatModel = currentModel;

    if (activeMessagesLog.some(m => m.role === 'user')) {
      toast('Replaying chat into engine context…', 'info', 2500);
      await rebuildEngineConversation();
      toast('Chat restored — context ready', 'success', 2600);
    } else {
      conversation = await engine.createConversation({
        preface: { messages: [{ role: 'system', content: SYSTEM_PREFACE }] }
      });
    }

    inputField.disabled = false;
    attachBtn.disabled = false;
    compressBtn.disabled = false;
    inputField.placeholder = 'Message CombsLLM…';
    setEngineStatus('ready', 'Ready');
    loadBtn.textContent = 'Reinitialize';
    loadBtn.disabled = false;
    $('model-select').disabled = false;

    toast('Engine ready — WebGPU inference running natively.', 'success');
    // On mobile, tuck the console away so the chat is front and center
    if (!desktopMQ.matches) {
      consolePanel.classList.add('collapsed');
      toggleConsoleBtn.classList.remove('active');
    }
    syncSendState();
    inputField.focus();
    await updateMetricsDashboard();
    await persistActiveChat();
  } catch (error) {
    toast(`Engine mount failure: ${error.message}`, 'error', 6000);
    setEngineStatus('', 'Error');
    loadBtn.textContent = engine ? 'Reinitialize' : 'Initialize engine';
    loadBtn.disabled = false;
    $('model-select').disabled = false;
  }
}

// ============================================================
// 8. MESSAGING
// ============================================================
function syncSendState() {
  const hasContent = inputField.value.trim().length > 0 || imageUpload.files.length > 0;
  sendBtn.disabled = !engine || generating || !hasContent;
}

async function sendMessage() {
  const text = inputField.value.trim();
  const file = imageUpload.files[0];
  if ((!text && !file) || !engine || generating) return;

  generating = true;
  inputField.value = '';
  inputField.style.height = 'auto';
  inputField.disabled = true;
  syncSendState();

  const contentStructure = [];
  if (text) contentStructure.push({ type: 'text', text });

  if (file) {
    addUserBubble(`[Image: ${file.name}] ${text}`.trim());
    const bitmap = await createImageBitmap(file);
    contentStructure.push({ type: 'image', data: bitmap });
    imageUpload.value = '';
    attachChip.classList.remove('visible');
    activeMessagesLog.push({ role: 'user', content: `[Image: ${file.name}] ${text}`.trim() });
  } else {
    addUserBubble(text);
    activeMessagesLog.push({ role: 'user', content: text });
  }

  await persistActiveChat();
  await updateMetricsDashboard();

  activeChatModel = currentModel;
  const { content, metrics } = addAiMessageShell(getModelName(activeChatModel));
  let generated = '';
  let renderQueued = false;
  const startedAt = performance.now();

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderMarkdownInto(content, generated, { streaming: true });
      scrollChatToBottom();
    });
  };
  scheduleRender();

  try {
    const useCaveman = cavemanToggle.checked;
    const finalPayload = preparePayload(
      contentStructure.length === 1 && contentStructure[0].type === 'text'
        ? contentStructure[0].text
        : contentStructure,
      useCaveman
    );
    if (useCaveman) console.log('Caveman Payload Sent:', finalPayload);

    const stream = conversation.sendMessageStreaming(finalPayload);
    for await (const chunk of stream) {
      for (const item of chunk.content) {
        if (item.type === 'text') {
          generated += item.text;
          scheduleRender();
        }
      }
    }
    activeMessagesLog.push({ role: 'assistant', content: generated });
  } catch (error) {
    generated += `\n\n*[Hardware truncation triggered: ${error.message}]*`;
    toast(`Generation interrupted: ${error.message}`, 'error', 5000);
  }

  renderMarkdownInto(content, generated, { streaming: false });

  const secs = (performance.now() - startedAt) / 1000;
  const estTokens = Math.ceil(generated.split(/\s+/).filter(Boolean).length * 1.3);
  const metricsData = generated.trim() && secs > 0.3 ? {
    tokens: estTokens,
    secs: Number(secs.toFixed(1)),
    tokPerSec: Number((estTokens / secs).toFixed(1))
  } : null;
  if (metricsData) {
    metrics.textContent = `~${metricsData.tokPerSec} tok/s · ${metricsData.secs}s`;
  }

  // Attach metrics to the assistant entry that was just pushed on success.
  const lastAssistant = activeMessagesLog[activeMessagesLog.length - 1];
  if (lastAssistant && lastAssistant.role === 'assistant') {
    lastAssistant.metrics = metricsData;
  }

  await persistActiveChat();
  await updateMetricsDashboard();

  generating = false;
  inputField.disabled = false;
  syncSendState();
  inputField.focus();
  scrollChatToBottom();
}

// ============================================================
// 9. COMPOSER WIRING
// ============================================================
inputField.addEventListener('input', () => {
  inputField.style.height = 'auto';
  inputField.style.height = Math.min(inputField.scrollHeight, 160) + 'px';
  syncSendState();
});

inputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

attachBtn.addEventListener('click', () => imageUpload.click());
imageUpload.addEventListener('change', () => {
  const f = imageUpload.files[0];
  if (f) {
    attachChipName.textContent = f.name;
    attachChip.classList.add('visible');
  } else {
    attachChip.classList.remove('visible');
  }
  syncSendState();
});
attachChipRemove.addEventListener('click', () => {
  imageUpload.value = '';
  attachChip.classList.remove('visible');
  syncSendState();
});

// ============================================================
// 10. GLOBAL BINDINGS & INIT
// ============================================================
// Load button: click initializes/reinitializes; long-press offloads the engine.
let pressTimer = null;
let longPressTriggered = false;
const LONG_PRESS_MS = 800;

function startLoadBtnPress(e) {
  if (!engine) return;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressTriggered = true;
    offloadEngine();
  }, LONG_PRESS_MS);
}
function cancelLoadBtnPress(e) {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

loadBtn.addEventListener('mousedown', startLoadBtnPress);
loadBtn.addEventListener('touchstart', startLoadBtnPress, { passive: true });
loadBtn.addEventListener('mouseup', cancelLoadBtnPress);
loadBtn.addEventListener('mouseleave', cancelLoadBtnPress);
loadBtn.addEventListener('touchend', cancelLoadBtnPress);
loadBtn.addEventListener('click', (e) => {
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }
  initModel();
});

confirmModalClose.addEventListener('click', hideConfirmModal);
confirmModalCancel.addEventListener('click', hideConfirmModal);
confirmModalConfirm.addEventListener('click', () => {
  if (confirmModalResolve) confirmModalResolve();
});
confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) hideConfirmModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!confirmModal.classList.contains('hidden')) hideConfirmModal();
    else if (!storageModal.classList.contains('hidden')) closeStorageModal();
  }
});

storageModalClose.addEventListener('click', closeStorageModal);
storageModalDone.addEventListener('click', closeStorageModal);
storageModalPurge.addEventListener('click', purgeAllStorage);
storageModal.addEventListener('click', (e) => {
  if (e.target === storageModal && confirmModal.classList.contains('hidden')) {
    closeStorageModal();
  }
});

sendBtn.addEventListener('click', sendMessage);
compressBtn.addEventListener('click', executeContextPruning);
clearCacheBtn.addEventListener('click', openStorageModal);
newChatBtn.addEventListener('click', () => startNewChat());
reasoningToggle.addEventListener('change', () => {
  // Re-render visible AI messages to show/hide thinking blocks
  renderAllMessages();
});
$('model-select').addEventListener('change', async () => {
  if (!engine) return;
  if (generating) {
    toast('Wait for the current reply to finish.', 'warning', 2600);
    syncModelSelect(currentModel || activeChatModel);
    return;
  }
  await initModel();
});

(async function init() {
  // Restore console collapsed preference
  if (localStorage.getItem('combsllm.consoleCollapsed') === '1') {
    consolePanel.classList.add('collapsed');
    toggleConsoleBtn.classList.remove('active');
  }

  try {
    await refreshSidebar();
    // Always start fresh on load; the sidebar still lists saved chats.
    localStorage.removeItem('combsllm.activeChatId');
  } catch (e) {
    console.warn('IndexedDB unavailable:', e);
    toast('Local storage unavailable — chats will not persist.', 'warning', 5000);
  }

  updateMetricsDashboard();
  setInterval(updateMetricsDashboard, 5000);

  // Preview mode for UI verification (?demo in URL) — no engine required
  if (location.search.includes('demo')) seedDemo();
})();

// ============================================================
// 11. DEMO SEEDER  (only active with ?demo in the URL)
// ============================================================
async function seedDemo() {
  const demoMd = [
    'Here is a **markdown** render check:\n',
    '### Features',
    '- Streaming *marked* parsing',
    '- `inline code` and fenced blocks',
    '- Tables, lists, quotes\n',
    '```js',
    'const kv = await cache.match(modelUrl);',
    'if (!kv) toast("Cache miss");',
    '```',
    '| Metric | Value |',
    '| --- | --- |',
    '| Heap | 412 MB |',
    '| KV cache | 1,204 tok |\n',
    '> System messages now surface as toasts, not chat rows.'
  ].join('\n');

  const thinkMd = '<think>The user wants a summary. I should keep it terse and skip the stop words to save KV cache space.</think>Caveman compression drops stop words before replaying history into the engine, cutting estimated tokens roughly **30–40%** on long sessions.';

  const chats = [
    {
      id: crypto.randomUUID(),
      title: 'Markdown render check',
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 3600000,
      messages: [
        { role: 'system', content: SYSTEM_PREFACE },
        { role: 'user', content: 'verify the markdown pipeline end to end' },
        { role: 'assistant', content: demoMd }
      ]
    },
    {
      id: crypto.randomUUID(),
      title: 'Why caveman compression?',
      createdAt: Date.now() - 172800000,
      updatedAt: Date.now() - 7200000,
      messages: [
        { role: 'system', content: SYSTEM_PREFACE },
        { role: 'user', content: 'why does caveman compression help?' },
        { role: 'assistant', content: thinkMd }
      ]
    }
  ];

  // Reset the store so re-visiting ?demo doesn't duplicate entries
  const existing = await idbGetAll();
  for (const c of existing) await idbDelete(c.id);

  for (const c of chats) await idbPut(c);
  await openChat(chats[0].id);
  setTimeout(() => toast('Model found in local cache.', 'info', 15000), 600);
  setTimeout(() => toast('Engine ready — WebGPU inference running natively.', 'success', 15000), 1400);
  setTimeout(() => toast('Context boundary breached — compressing memory.', 'warning', 15000), 2200);
}
