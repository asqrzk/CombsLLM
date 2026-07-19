// ============================================================
// Image pipeline: validate -> pass through or downscale -> data URL.
// Images already within bounds keep their original bytes; larger ones
// are downscaled so the longest side fits IMAGE_MAX_DIM and re-encoded.
// ============================================================
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIM, IMAGE_MIME_WHITELIST } from './config.js';
import { formatBytes } from './text.js';

export function validateImageFile(file) {
  if (!IMAGE_MIME_WHITELIST.has(file.type)) {
    return `Unsupported format "${file.type || 'unknown'}". Use PNG, JPEG or WebP.`;
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return `"${file.name}" is ${formatBytes(file.size)} — the limit is ${formatBytes(IMAGE_MAX_BYTES)}.`;
  }
  return null;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Strip the "data:image/...;base64," prefix — backends want raw base64.
export function dataUrlToBase64(dataUrl) {
  return dataUrl.split(',', 2)[1];
}

let webpEncodeSupported = null;
function supportsWebpEncode() {
  if (webpEncodeSupported === null) {
    webpEncodeSupported = document.createElement('canvas')
      .toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpEncodeSupported;
}

export async function processImageFile(file) {
  const err = validateImageFile(file);
  if (err) throw new Error(err);

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(width, height));

  if (scale === 1) {
    const dataUrl = await blobToDataUrl(file);
    bitmap.close();
    return { dataUrl, width, height, resized: false };
  }

  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const useWebp = supportsWebpEncode();
  if (!useWebp) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // JPEG has no alpha
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const encode = (type, quality) => new Promise(r => canvas.toBlob(r, type, quality));
  let blob = useWebp ? await encode('image/webp', 0.92) : await encode('image/jpeg', 0.92);
  if (!blob) blob = await encode('image/png');
  if (!blob) throw new Error('Image re-encode failed in this browser.');

  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, width: w, height: h, resized: true, originalWidth: width, originalHeight: height };
}
