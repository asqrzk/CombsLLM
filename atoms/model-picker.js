// ============================================================
// Model picker: searchable/filterable model catalog with expandable
// architecture details, local-cache indicators, and the collapsible
// HF token editor. Owns model selection state for the app.
// ============================================================
import {
  MODELS, ARCHITECTURE_STAGES, ARCHITECTURE_STAGE_LABELS, modelDownloadUrl
} from './config.js';
import {
  modelSearch, hfTokenToggle, hfTokenRow, hfTokenInput, hfTokenEye,
  hfTokenSave, modelFilters, modelList, modelCacheCount
} from './dom.js';
import { escapeHtml } from './text.js';
import { toast } from './ui.js';

// Filter facets: capability tags, suggested runtime, and cache status.
const FILTER_FACETS = [
  { id: 'text', label: 'text', match: (def) => def.tags?.includes('text') },
  { id: 'vision', label: 'vision', match: (def) => def.tags?.includes('vision') },
  { id: 'audio', label: 'audio', match: (def) => def.tags?.includes('audio') },
  { id: 'litert', label: 'litert-lm', match: (def) => def.runtime === 'litert' },
  { id: 'tasks', label: 'tasks-genai', match: (def) => def.runtime === 'tasks' },
  { id: 'litertjs', label: 'litert.js', match: (def) => def.runtime === 'litertjs' },
  { id: 'cached', label: 'cached', match: (def, ctx) => ctx.cachedUrls.has(modelDownloadUrl(def)) }
];

let selectedId = null;
let disabled = false;
let onChangeCb = null;
let cachedUrls = new Set();
const activeFilters = new Set();

export function getSelectedModelId() {
  return selectedId;
}

export function setSelectedModelId(id) {
  if (MODELS[id]) {
    selectedId = id;
    renderList();
  }
}

export function setModelPickerDisabled(value) {
  disabled = value;
  modelList.classList.toggle('disabled', value);
  modelSearch.disabled = value;
}

// Re-scan the Cache API: updates the "N models cached" line and per-row badges.
export async function refreshModelCacheInfo() {
  cachedUrls = new Set();
  let count = 0;
  if (window.caches) {
    for (const name of await caches.keys()) {
      const requests = await (await caches.open(name)).keys();
      count += requests.length;
      for (const r of requests) cachedUrls.add(typeof r === 'string' ? r : r.url);
    }
  }
  modelCacheCount.textContent = `${count} model${count === 1 ? '' : 's'} cached locally`;
  renderList();
}

function matches(id, def, query) {
  if (query) {
    const haystack = `${id} ${def.label} ${def.repo} ${def.file} ${(def.tags || []).join(' ')}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  for (const filterId of activeFilters) {
    const facet = FILTER_FACETS.find(f => f.id === filterId);
    if (facet && !facet.match(def, { cachedUrls })) return false;
  }
  return true;
}

function architectureTableHtml(def) {
  const arch = def.architecture || {};
  const rows = ARCHITECTURE_STAGES
    .filter(stage => arch[stage])
    .map(stage => `<tr><td>${escapeHtml(ARCHITECTURE_STAGE_LABELS[stage] || stage)}</td><td>${escapeHtml(arch[stage])}</td></tr>`)
    .join('');
  return rows ? `<table class="arch-table">${rows}</table>` : '<div class="model-list-empty">No architecture details.</div>';
}

function renderFilters() {
  modelFilters.innerHTML = '';
  for (const facet of FILTER_FACETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip' + (activeFilters.has(facet.id) ? ' active' : '');
    chip.textContent = facet.label;
    chip.addEventListener('click', () => {
      if (activeFilters.has(facet.id)) activeFilters.delete(facet.id);
      else activeFilters.add(facet.id);
      renderFilters();
      renderList();
    });
    modelFilters.appendChild(chip);
  }
}

function renderList() {
  const query = modelSearch.value.trim().toLowerCase();
  modelList.innerHTML = '';
  const entries = Object.entries(MODELS).filter(([id, def]) => matches(id, def, query));
  if (!entries.length) {
    modelList.innerHTML = '<div class="model-list-empty">No models match the current filters.</div>';
    return;
  }
  for (const [id, def] of entries) {
    const cached = cachedUrls.has(modelDownloadUrl(def));
    const tagsHtml = (def.tags || []).map(t => `<span class="model-tag">${escapeHtml(t)}</span>`).join('');
    const row = document.createElement('div');
    row.className = 'model-row' + (id === selectedId ? ' selected' : '');
    row.innerHTML = `
      <div class="model-row-header">
        <div class="model-row-main">
          <div class="model-row-name">${escapeHtml(def.file)}</div>
          <div class="model-row-sub">${escapeHtml(def.repo)} · ${escapeHtml(def.size || 'size unknown')}</div>
          <div class="model-row-tags">${tagsHtml}${cached ? '<span class="model-tag tag-cached">cached</span>' : ''}</div>
        </div>
        <button type="button" class="model-row-expand" aria-label="Toggle architecture details">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
      <div class="model-row-details">${architectureTableHtml(def)}</div>`;
    row.querySelector('.model-row-header').addEventListener('click', (e) => {
      if (disabled || e.target.closest('.model-row-expand')) return;
      if (id !== selectedId) {
        selectedId = id;
        renderList();
        if (onChangeCb) onChangeCb(id);
      }
    });
    row.querySelector('.model-row-expand').addEventListener('click', (e) => {
      e.stopPropagation();
      row.classList.toggle('open');
    });
    modelList.appendChild(row);
  }
}

function updateTokenToggleState() {
  hfTokenToggle.classList.toggle('has-token', !!hfTokenInput.value.trim());
}

function saveToken() {
  localStorage.setItem('combsllm.hfToken', hfTokenInput.value.trim());
  hfTokenRow.classList.add('hidden');
  updateTokenToggleState();
  toast(hfTokenInput.value.trim() ? 'HF token saved locally.' : 'HF token cleared.', 'success', 2600);
}

export function initModelPicker({ onChange } = {}) {
  onChangeCb = onChange;
  if (!selectedId || !MODELS[selectedId]) selectedId = Object.keys(MODELS)[0];
  renderFilters();
  renderList();

  modelSearch.addEventListener('input', renderList);

  // Collapsible HF token editor (only needed for gated repos).
  hfTokenInput.value = localStorage.getItem('combsllm.hfToken') || '';
  updateTokenToggleState();
  hfTokenToggle.addEventListener('click', () => hfTokenRow.classList.toggle('hidden'));
  hfTokenSave.addEventListener('click', saveToken);
  hfTokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
  hfTokenEye.addEventListener('click', () => {
    hfTokenInput.type = hfTokenInput.type === 'password' ? 'text' : 'password';
  });
}
