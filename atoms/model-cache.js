// ============================================================
// Model download + Cache API storage. The response body streams
// straight into the cache (disk-backed) with a progress tap, so the
// JS heap never holds more than one network chunk. Engines receive a
// disk-backed blob URL re-opened from the cache afterwards.
// ============================================================
import { toast } from './ui.js';
import {
  hfTokenInput, downloadUI, downloadStatus, downloadPercent, downloadProgress
} from './dom.js';

const CACHE_NAME = 'litert-models-v1';

function hfAuthHeaders() {
  const token = (hfTokenInput?.value || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchAndCacheModel(modelUrl) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(modelUrl);

  if (cachedResponse) {
    toast('Model found in local cache — loading instantly from disk.', 'info', 3000);
    const blob = await cachedResponse.blob();
    return URL.createObjectURL(blob);
  }

  toast('Model not cached. Downloading from Hugging Face…', 'info', 3500);
  downloadUI.classList.add('visible');

  const response = await fetch(modelUrl, { headers: hfAuthHeaders() });
  if (!response.ok) {
    downloadUI.classList.remove('visible');
    const gatedHint = (response.status === 401 || response.status === 403)
      ? ' — gated repo. Accept the license on its Hugging Face page, then paste your HF access token in the console field and retry.'
      : '';
    throw new Error(`HTTP error! status: ${response.status}${gatedHint}`);
  }

  const totalBytes = parseInt(response.headers.get('content-length'), 10);
  let loadedBytes = 0;

  const progressTap = new TransformStream({
    transform(chunk, controller) {
      loadedBytes += chunk.byteLength;
      if (totalBytes) {
        const percent = Math.round((loadedBytes / totalBytes) * 100);
        downloadPercent.innerText = `${percent}%`;
        downloadProgress.style.width = `${percent}%`;
        downloadStatus.innerText = `Downloading: ${(loadedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`;
      }
      controller.enqueue(chunk);
    }
  });

  await cache.put(modelUrl, new Response(response.body.pipeThrough(progressTap), { headers: response.headers }));

  downloadUI.classList.remove('visible');
  toast('Download complete — model cached on this device.', 'success', 3200);

  const stored = await cache.match(modelUrl);
  const blob = await stored.blob();
  return URL.createObjectURL(blob);
}

// ---- Storage manager helpers ----

export function cacheUrlToName(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() || url;
    return filename.replace('.litertlm', '').replace('.task', '').replace(/-/g, ' ');
  } catch {
    return url;
  }
}

export async function getCacheItems() {
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
        if (response) size = (await response.blob()).size;
      } catch { /* entry unreadable */ }
      items.push({ cacheName: name, url, name: cacheUrlToName(url), size });
    }
  }
  return items;
}

export async function deleteCacheItem(cacheName, url) {
  const cache = await caches.open(cacheName);
  await cache.delete(url);
}
