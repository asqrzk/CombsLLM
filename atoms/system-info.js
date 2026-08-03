// ============================================================
// System & browser info panel.
// Functional capability detection: browsers do not expose chrome://flags
// state or raw VRAM, so support is probed (WebGPU adapter acquisition,
// WebNN API presence) and adapter limits serve as GPU memory proxies.
// ============================================================
import {
  sysinfoBtn, sysinfoModal, sysinfoModalBody, sysinfoModalClose, sysinfoModalDone,
  sysinfoCpuToggle
} from './dom.js';
import { formatBytes } from './text.js';
import { toast } from './ui.js';

const FORCE_CPU_KEY = 'combsllm.forceCpu';

// App-level WebGPU override: LiteRT-LM mounts its CPU backend when enabled.
export function isCpuForced() {
  return localStorage.getItem(FORCE_CPU_KEY) === '1';
}

function detectBrowser() {
  const ua = navigator.userAgent;
  let m;
  if ((m = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) return { name: 'Microsoft Edge', version: m[1] };
  if ((m = ua.match(/OPR\/([\d.]+)/))) return { name: 'Opera', version: m[1] };
  if ((m = ua.match(/Chrome\/([\d.]+)/))) return { name: 'Google Chrome', version: m[1] };
  if ((m = ua.match(/Firefox\/([\d.]+)/))) return { name: 'Mozilla Firefox', version: m[1] };
  if ((m = ua.match(/Version\/([\d.]+).*Safari/))) return { name: 'Safari', version: m[1] };
  return { name: 'Unknown browser', version: '' };
}

async function probeWebGPU() {
  if (!navigator.gpu) return { supported: false, reason: 'navigator.gpu missing' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { supported: false, reason: 'no adapter returned' };
    const info = adapter.info || {};
    return {
      supported: true,
      description: info.description || [info.vendor, info.architecture].filter(Boolean).join(' ') || 'GPU adapter',
      maxBuffer: adapter.limits?.maxBufferSize,
      maxStorageBuffer: adapter.limits?.maxStorageBufferBindingSize
    };
  } catch (e) {
    return { supported: false, reason: e.message };
  }
}

function row(label, value, cls = '') {
  return `<div class="sysinfo-row"><span>${label}</span><span class="${cls}">${value}</span></div>`;
}

async function renderInfo() {
  const browser = detectBrowser();
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Unknown';
  const gpu = await probeWebGPU();
  const webnn = 'ml' in navigator;

  let html = '';
  html += row('Browser', `${browser.name} ${browser.version}`.trim());
  html += row('Platform', platform);
  html += row('CPU cores', navigator.hardwareConcurrency || 'Unknown');
  html += row(
    'System RAM',
    navigator.deviceMemory ? `≥ ${navigator.deviceMemory} GB (browser-reported)` : 'Not exposed by this browser'
  );
  html += row(
    'JS heap limit',
    performance.memory ? formatBytes(performance.memory.jsHeapSizeLimit) : 'Not exposed by this browser'
  );
  html += row(
    'WebGPU',
    gpu.supported ? 'Active' : `Unavailable${gpu.reason ? ` (${gpu.reason})` : ''}`,
    gpu.supported ? 'sysinfo-ok' : 'sysinfo-bad'
  );
  if (gpu.supported) {
    html += row('GPU adapter', gpu.description);
    if (gpu.maxBuffer) html += row('Max GPU buffer', formatBytes(gpu.maxBuffer));
    if (gpu.maxStorageBuffer) html += row('Max storage buffer', formatBytes(gpu.maxStorageBuffer));
  }
  html += row(
    'WebNN',
    webnn ? 'API present' : 'Unavailable',
    webnn ? 'sysinfo-ok' : 'sysinfo-bad'
  );
  html += `<div class="sysinfo-note">Capability flags can't be read from a page — these are live probes. If WebGPU/WebNN show unavailable, check chrome://flags#enable-unsafe-webgpu and chrome://flags#enable-webnn (Edge: edge://flags, Firefox: about:config → dom.webgpu.enabled).</div>`;
  sysinfoModalBody.innerHTML = html;
}

function openModal() {
  sysinfoModalBody.innerHTML = '<div class="sysinfo-note">Probing…</div>';
  sysinfoModal.classList.remove('hidden');
  renderInfo();
}

export function closeSystemInfoModal() {
  sysinfoModal.classList.add('hidden');
}

export function initSystemInfo() {
  sysinfoBtn.addEventListener('click', openModal);
  sysinfoModalClose.addEventListener('click', closeSystemInfoModal);
  sysinfoModalDone.addEventListener('click', closeSystemInfoModal);
  sysinfoModal.addEventListener('click', (e) => {
    if (e.target === sysinfoModal) closeSystemInfoModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sysinfoModal.classList.contains('hidden')) {
      closeSystemInfoModal();
    }
  });

  sysinfoCpuToggle.checked = isCpuForced();
  sysinfoCpuToggle.addEventListener('change', () => {
    localStorage.setItem(FORCE_CPU_KEY, sysinfoCpuToggle.checked ? '1' : '0');
    toast(
      sysinfoCpuToggle.checked
        ? 'Force CPU enabled — LiteRT-LM will skip WebGPU on next initialize.'
        : 'Force CPU disabled — WebGPU will be used on next initialize.',
      'info', 3200
    );
  });
}
