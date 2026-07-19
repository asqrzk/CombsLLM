// ============================================================
// DOM bindings — every element the app touches, resolved once.
// ============================================================

export const $ = (id) => document.getElementById(id);

export const app = $('app');
export const chatBox = $('chat-box');
export const chatScroll = $('chat-scroll');
export const chatEmpty = $('chat-empty');
export const inputField = $('prompt-input');
export const sendBtn = $('send-btn');
export const loadBtn = $('load-btn');
export const attachBtn = $('attach-btn');
export const imageUpload = $('image-upload');
export const attachChip = $('attach-chip');
export const attachChipName = $('attach-chip-name');
export const attachChipRemove = $('attach-chip-remove');
export const compressBtn = $('compress-btn');
export const clearCacheBtn = $('clear-cache-btn');
export const contextLimitInput = $('context-limit');
export const cavemanToggle = $('caveman-toggle');
export const reasoningToggle = $('reasoning-toggle');
export const visionToggle = $('vision-toggle');
export const audioToggle = $('audio-toggle');
export const menuBtn = $('menu-btn');
export const sidebarBackdrop = $('sidebar-backdrop');
export const sidebarCloseBtn = $('sidebar-close-btn');
export const newChatBtn = $('new-chat-btn');
export const chatListEl = $('chat-list');
export const headerTitle = $('header-title');
export const engineStatus = $('engine-status');
export const engineStatusText = $('engine-status-text');
export const toggleConsoleBtn = $('toggle-console-btn');
export const consolePanel = $('console-panel');
export const toastContainer = $('toast-container');
export const sidebarStorageTxt = $('sidebar-storage-txt');
export const modelSelect = $('model-select');
export const hfTokenInput = $('hf-token');

export const jsHeapTxt = $('js-heap-txt');
export const kvCacheTxt = $('kv-cache-txt');
export const contextProgress = $('context-progress');
export const diskUsageTxt = $('disk-usage-txt');
export const downloadUI = $('download-ui');
export const downloadStatus = $('download-status');
export const downloadPercent = $('download-percent');
export const downloadProgress = $('download-progress');

export const confirmModal = $('confirm-modal');
export const confirmModalTitle = $('confirm-modal-title');
export const confirmModalBody = $('confirm-modal-body');
export const confirmModalClose = $('confirm-modal-close');
export const confirmModalCancel = $('confirm-modal-cancel');
export const confirmModalConfirm = $('confirm-modal-confirm');

export const storageModal = $('storage-modal');
export const storageModalBody = $('storage-modal-body');
export const storageModalClose = $('storage-modal-close');
export const storageModalDone = $('storage-modal-done');
export const storageModalPurge = $('storage-modal-purge');
