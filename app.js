// ============================================================
// CombsLLM — application orchestration.
// UI wiring, chat session management, engine lifecycle, metrics.
// Backends, storage, rendering and pipelines live in js/ modules.
// ============================================================
import {
  SYSTEM_PREFACE, DB_NAME,
  getModelDef, getModelName, modelDownloadUrl
} from './js/config.js';
import { state } from './js/state.js';
import {
  app, chatBox, inputField, sendBtn, loadBtn, attachBtn, imageUpload,
  attachChip, attachChipName, attachChipRemove, compressBtn, clearCacheBtn,
  contextLimitInput, cavemanToggle, reasoningToggle, visionToggle, audioToggle,
  menuBtn, sidebarBackdrop, sidebarCloseBtn, newChatBtn, chatListEl, headerTitle,
  engineStatus, engineStatusText, toggleConsoleBtn, consolePanel,
  sidebarStorageTxt, modelSelect, hfTokenInput,
  jsHeapTxt, kvCacheTxt, contextProgress, diskUsageTxt,
  confirmModal, storageModal, storageModalBody,
  storageModalClose, storageModalDone, storageModalPurge
} from './js/dom.js';
import { idbPut, idbGet, idbGetAll, idbDelete } from './js/store.js';
import { toast, showConfirmModal, hideConfirmModal } from './js/ui.js';
import {
  renderMarkdownInto, renderAllMessages, addUserBubble, addAiMessageShell,
  syncEmptyState, scrollChatToBottom
} from './js/chat-ui.js';
import { escapeHtml, formatBytes, deriveTitle, estimateMessageTokens } from './js/text.js';
import { validateImageFile, processImageFile } from './js/image.js';
import {
  fetchAndCacheModel, getCacheItems, deleteCacheItem
} from './js/model-cache.js';
import { createBackend } from './js/backends/index.js';

// ============================================================
// MODEL SELECT HELPERS
// ============================================================
function getSelectedModel() {
  return modelSelect.value;
}

function syncModelSelect(modelId) {
  if (modelId && modelSelect.value !== modelId) {
    modelSelect.value = modelId;
  }
}

// ============================================================
// CHAT SESSION MANAGEMENT
// ============================================================
async function persistActiveChat() {
  if (state.isRestoring) return;
  if (!state.activeMessagesLog.some(m => m.role === 'user')) return;
  try {
    const now = Date.now();
    if (!state.activeChatId) state.activeChatId = crypto.randomUUID();
    const existing = await idbGet(state.activeChatId);
    await idbPut({
      id: state.activeChatId,
      title: deriveTitle(state.activeMessagesLog),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      model: state.activeChatModel || state.currentModel || getSelectedModel(),
      messages: state.activeMessagesLog
    });
    localStorage.setItem('combsllm.activeChatId', state.activeChatId);
    headerTitle.textContent = deriveTitle(state.activeMessagesLog);
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
    item.className = 'chat-item' + (c.id === state.activeChatId ? ' active' : '');
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
          if (c.id === state.activeChatId) await startNewChat(false);
          await refreshSidebar();
          hideConfirmModal();
        }
      });
    });
    chatListEl.appendChild(item);
  }
}

async function startNewChat(focusInput = true) {
  if (state.generating) { toast('Wait for the current reply to finish.', 'warning', 2600); return; }
  state.activeChatId = null;
  state.activeChatModel = null;
  state.activeMessagesLog = [{ role: 'system', content: SYSTEM_PREFACE }];
  syncModelSelect(state.currentModel || getSelectedModel());
  localStorage.removeItem('combsllm.activeChatId');
  chatBox.querySelectorAll('.message').forEach(m => m.remove());
  syncEmptyState();
  headerTitle.textContent = 'New chat';
  await refreshSidebar();
  closeMobileSidebar();
  if (state.backend) {
    try { await state.backend.resetContext(state.activeMessagesLog); } catch (e) { console.warn(e); }
  }
  updateMetricsDashboard();
  if (focusInput && !inputField.disabled) inputField.focus();
}

async function openChat(id) {
  if (id === state.activeChatId) { closeMobileSidebar(); return; }
  if (state.generating) { toast('Wait for the current reply to finish.', 'warning', 2600); return; }
  state.isRestoring = true;
  let chat;
  try { chat = await idbGet(id); } catch (e) { chat = null; }
  if (!chat) { state.isRestoring = false; toast('Could not load chat', 'error'); return; }

  state.activeChatId = id;
  state.activeMessagesLog = chat.messages || [];
  state.activeChatModel = chat.model || null;
  if (state.activeChatModel) syncModelSelect(state.activeChatModel);
  localStorage.setItem('combsllm.activeChatId', id);
  renderAllMessages();
  await refreshSidebar();
  state.isRestoring = false;
  closeMobileSidebar();
  updateMetricsDashboard();

  if (state.backend && state.activeMessagesLog.some(m => m.role === 'user')) {
    if (state.activeChatModel && state.currentModel && state.currentModel !== state.activeChatModel) {
      // Swap to the model this conversation was created with.
      await initModel();
    } else if (state.backend.kind === 'litert') {
      toast('Replaying chat into engine context…', 'info', 2500);
      try {
        await state.backend.resetContext(state.activeMessagesLog, { caveman: cavemanToggle.checked });
        toast('Chat restored — context ready', 'success', 2600);
      } catch (e) {
        toast('Context restore failed: ' + e.message, 'error');
      }
    }
    // tasks backend: context is rebuilt from the log on every send.
  } else if (!state.backend) {
    toast('Chat loaded. Initialize the engine to continue it.', 'info', 3200);
  }
}

// ============================================================
// SIDEBAR / LAYOUT BEHAVIOR
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
// HARDWARE & STORAGE MONITORING
// ============================================================
async function updateMetricsDashboard() {
  if (performance.memory) {
    const usedHeap = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
    const totalHeap = (performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(1);
    jsHeapTxt.innerText = `${usedHeap} MB / ${totalHeap} MB`;
  }

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const used = formatBytes(estimate.usage);
      diskUsageTxt.innerText = `${used} utilized`;
      sidebarStorageTxt.textContent = `${used} stored locally`;
    } catch (e) { /* ignore */ }
  }

  let estimatedTokens = 0;
  state.activeMessagesLog.forEach(msg => {
    estimatedTokens += estimateMessageTokens(msg);
  });

  const maxThreshold = parseInt(contextLimitInput.value) || 32000;
  kvCacheTxt.innerText = `${estimatedTokens} / ${maxThreshold} est. tokens`;

  const percentage = Math.min((estimatedTokens / maxThreshold) * 100, 100);
  contextProgress.style.width = `${percentage}%`;
  contextProgress.className = 'progress-fill';
  if (percentage > 85) contextProgress.classList.add('danger');
  else if (percentage > 60) contextProgress.classList.add('warning');

  if (estimatedTokens > maxThreshold && state.backend && !state.pruning && !state.generating) {
    toast('Context boundary breached — compressing memory automatically.', 'warning');
    await executeContextPruning();
  }
}

// ============================================================
// CONTEXT PRUNING
// ============================================================
async function executeContextPruning() {
  if (!state.backend) { toast('Initialize the engine first.', 'warning', 2600); return; }
  if (state.pruning) return;
  state.pruning = true;
  const maxThreshold = parseInt(contextLimitInput.value) || 2048;
  toast('Compressing KV cache — truncating older entries…', 'info', 3000);

  while (state.activeMessagesLog.length > 2) {
    const idx = state.activeMessagesLog.findIndex(m => m.role !== 'system');
    if (idx === -1) break;
    state.activeMessagesLog.splice(idx, 1);
    const currentEst = state.activeMessagesLog.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    if (currentEst <= maxThreshold * 0.7) break;
  }

  try {
    await state.backend.resetContext(state.activeMessagesLog, { caveman: cavemanToggle.checked });
    renderAllMessages();
    await persistActiveChat();
    toast('Context compression complete.', 'success', 2600);
  } catch (e) {
    toast('Compression failed: ' + e.message, 'error');
  }
  state.pruning = false;
  await updateMetricsDashboard();
}

// ============================================================
// STORAGE MANAGER MODAL
// ============================================================
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
    row.querySelector('.storage-item-delete').addEventListener('click', async () => {
      try {
        await deleteCacheItem(item.cacheName, item.url);
        toast('Model removed from cache.', 'success', 2600);
      } catch (e) {
        toast('Failed to remove model: ' + e.message, 'error');
      }
      await renderStorageList();
      await updateMetricsDashboard();
    });
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
// ENGINE LIFECYCLE
// ============================================================
function setEngineStatus(state_, text) {
  engineStatus.classList.remove('loading', 'ready');
  loadBtn.classList.remove('loading', 'ready');
  if (state_) {
    engineStatus.classList.add(state_);
    loadBtn.classList.add(state_);
  }
  engineStatusText.textContent = text;
}

async function disposeBackend() {
  if (state.backend) {
    try { await state.backend.dispose(); } catch (e) { console.warn('Backend dispose error:', e); }
    state.backend = null;
  }
  if (state.modelBlobUrl) { URL.revokeObjectURL(state.modelBlobUrl); state.modelBlobUrl = null; }
}

async function offloadEngine() {
  if (!state.backend) return;
  loadBtn.disabled = true;
  modelSelect.disabled = false;
  setEngineStatus('', 'Idle');
  await disposeBackend();
  state.currentModel = null;
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
  modelSelect.disabled = true;
  loadBtn.textContent = 'Initializing…';
  setEngineStatus('loading', 'Loading');
  const modelName = getSelectedModel();
  const modelDef = getModelDef(modelName);
  if (!modelDef) {
    toast(`Unknown model: ${modelName}`, 'error');
    setEngineStatus('', 'Error');
    loadBtn.textContent = 'Initialize engine';
    loadBtn.disabled = false;
    modelSelect.disabled = false;
    return;
  }

  try {
    await disposeBackend();
    const localBlobUrl = await fetchAndCacheModel(modelDownloadUrl(modelDef));
    state.modelBlobUrl = localBlobUrl;

    toast(`Mounting ${modelDef.label}…`, 'info', 2800);
    state.backend = createBackend(modelDef);
    await state.backend.mount(modelDef, localBlobUrl, {
      vision: visionToggle.checked,
      audio: audioToggle.checked
    });

    state.currentModel = modelName;
    state.activeChatModel = modelName;

    if (state.activeMessagesLog.some(m => m.role === 'user')) {
      toast('Replaying chat into engine context…', 'info', 2500);
      await state.backend.resetContext(state.activeMessagesLog, { caveman: cavemanToggle.checked });
      toast('Chat restored — context ready', 'success', 2600);
    } else {
      await state.backend.resetContext(state.activeMessagesLog);
    }

    inputField.disabled = false;
    attachBtn.disabled = false;
    compressBtn.disabled = false;
    inputField.placeholder = 'Message CombsLLM…';
    setEngineStatus('ready', 'Ready');
    loadBtn.textContent = 'Reinitialize';
    loadBtn.disabled = false;
    modelSelect.disabled = false;

    toast('Engine ready — WebGPU inference running natively.', 'success');
    // On mobile, tuck the console away so the chat is front and center.
    if (!desktopMQ.matches) {
      consolePanel.classList.add('collapsed');
      toggleConsoleBtn.classList.remove('active');
    }
    syncSendState();
    inputField.focus();
    await updateMetricsDashboard();
    await persistActiveChat();
  } catch (error) {
    await disposeBackend();
    toast(`Engine mount failure: ${error.message}`, 'error', 6000);
    setEngineStatus('', 'Error');
    loadBtn.textContent = 'Initialize engine';
    loadBtn.disabled = false;
    modelSelect.disabled = false;
  }
}

// ============================================================
// MESSAGING
// ============================================================
function syncSendState() {
  const hasContent = inputField.value.trim().length > 0 || imageUpload.files.length > 0;
  sendBtn.disabled = !state.backend || state.generating || !hasContent;
}

async function sendMessage() {
  const text = inputField.value.trim();
  const file = imageUpload.files[0];
  if ((!text && !file) || !state.backend || state.generating) return;

  state.generating = true;
  syncSendState();

  // Validate + downscale before clearing the composer, so a rejection
  // doesn't eat the user's typed message.
  let imagePart = null;
  if (file) {
    if (!visionToggle.checked) {
      toast('Vision is off. Enable the Vision toggle and reinitialize the engine to send images.', 'warning', 4800);
      state.generating = false;
      syncSendState();
      return;
    }
    try {
      const processed = await processImageFile(file);
      imagePart = {
        type: 'image',
        dataUrl: processed.dataUrl,
        name: file.name,
        width: processed.width,
        height: processed.height
      };
      if (processed.resized) {
        toast(`Image downscaled ${processed.originalWidth}×${processed.originalHeight} → ${processed.width}×${processed.height} for efficient inference.`, 'info', 3200);
      }
    } catch (err) {
      toast(`Image rejected: ${err.message}`, 'error', 4500);
      state.generating = false;
      syncSendState();
      return;
    }
  }

  inputField.value = '';
  inputField.style.height = 'auto';
  inputField.disabled = true;
  syncSendState();

  const contentStructure = [];
  if (text) contentStructure.push({ type: 'text', text });
  if (imagePart) contentStructure.push(imagePart);

  // Single text part stays a plain string; anything with an image becomes a part array.
  const logContent = (contentStructure.length === 1 && contentStructure[0].type === 'text')
    ? text
    : contentStructure;

  addUserBubble(text, imagePart?.dataUrl || null);
  state.activeMessagesLog.push({ role: 'user', content: logContent });
  imageUpload.value = '';
  attachChip.classList.remove('visible');

  await persistActiveChat();
  await updateMetricsDashboard();

  state.activeChatModel = state.currentModel;
  const { content, metrics } = addAiMessageShell(getModelName(state.activeChatModel));
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
    const result = await state.backend.send(
      logContent,
      { history: state.activeMessagesLog, caveman: cavemanToggle.checked },
      (partial) => { generated += partial; scheduleRender(); }
    );
    if (result && result !== generated) generated = result;
    state.activeMessagesLog.push({ role: 'assistant', content: generated });
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

  const lastAssistant = state.activeMessagesLog[state.activeMessagesLog.length - 1];
  if (lastAssistant && lastAssistant.role === 'assistant') {
    lastAssistant.metrics = metricsData;
  }

  await persistActiveChat();
  await updateMetricsDashboard();

  state.generating = false;
  inputField.disabled = false;
  syncSendState();
  inputField.focus();
  scrollChatToBottom();
}

// ============================================================
// COMPOSER WIRING
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
    if (!visionToggle.checked) {
      toast('Vision is off. Enable the Vision toggle in the engine console, then reinitialize the engine to attach images.', 'warning', 5200);
      imageUpload.value = '';
      attachChip.classList.remove('visible');
      syncSendState();
      return;
    }
    const err = validateImageFile(f);
    if (err) {
      toast(err, 'error', 4500);
      imageUpload.value = '';
      attachChip.classList.remove('visible');
      syncSendState();
      return;
    }
    attachChipName.textContent = `${f.name} · ${formatBytes(f.size)}`;
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
// GLOBAL BINDINGS & INIT
// ============================================================
// Load button: click initializes/reinitializes; long-press offloads the engine.
let pressTimer = null;
let longPressTriggered = false;
const LONG_PRESS_MS = 800;

function startLoadBtnPress() {
  if (!state.backend) return;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressTriggered = true;
    offloadEngine();
  }, LONG_PRESS_MS);
}
function cancelLoadBtnPress() {
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
loadBtn.addEventListener('click', () => {
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }
  initModel();
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
  renderAllMessages();
});

// Modality toggles: persisted, applied at next engine (re)initialization.
function onModalityToggle(name, input) {
  localStorage.setItem(`combsllm.${name}`, input.checked ? '1' : '0');
  if (state.backend) {
    toast(`${name === 'vision' ? 'Vision' : 'Audio'} ${input.checked ? 'enabled' : 'disabled'} — reinitialize the engine to apply.`, 'info', 3600);
  }
}
visionToggle.addEventListener('change', () => onModalityToggle('vision', visionToggle));
audioToggle.addEventListener('change', () => onModalityToggle('audio', audioToggle));

hfTokenInput.addEventListener('change', (e) => {
  localStorage.setItem('combsllm.hfToken', e.target.value.trim());
  if (e.target.value.trim()) toast('HF token saved locally — gated repos will use it on next download.', 'success', 2800);
});

modelSelect.addEventListener('change', async () => {
  if (!state.backend) return;
  if (state.generating) {
    toast('Wait for the current reply to finish.', 'warning', 2600);
    syncModelSelect(state.currentModel || state.activeChatModel);
    return;
  }
  await initModel();
});

(async function init() {
  if (localStorage.getItem('combsllm.consoleCollapsed') === '1') {
    consolePanel.classList.add('collapsed');
    toggleConsoleBtn.classList.remove('active');
  }

  visionToggle.checked = localStorage.getItem('combsllm.vision') === '1';
  audioToggle.checked = localStorage.getItem('combsllm.audio') === '1';
  hfTokenInput.value = localStorage.getItem('combsllm.hfToken') || '';

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

  if (location.search.includes('demo')) seedDemo();
})();

// ============================================================
// DEMO SEEDER (only active with ?demo in the URL)
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

  // Reset the store so re-visiting ?demo doesn't duplicate entries.
  const existing = await idbGetAll();
  for (const c of existing) await idbDelete(c.id);

  for (const c of chats) await idbPut(c);
  await openChat(chats[0].id);
  setTimeout(() => toast('Model found in local cache.', 'info', 15000), 600);
  setTimeout(() => toast('Engine ready — WebGPU inference running natively.', 'success', 15000), 1400);
  setTimeout(() => toast('Context boundary breached — compressing memory.', 'warning', 15000), 2200);
}
