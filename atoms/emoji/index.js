// ============================================================
// emoji atom — client for the server's /api/emoji/* living-emoji host.
// Capability only (no DOM): flows render what these return.
// ============================================================

async function api(path, options) {
  const res = await fetch(`/api/emoji${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error('not authenticated — reload and unlock with your passkey');
  }
  if (res.status === 503) {
    throw new Error(data.error || 'emoji host disabled on this server');
  }
  return data;
}

export const emojiHost = {
  state: () => api('/state'),
  frames: () => api('/frames'),
  unicode: () => api('/unicode'),
  chat: (message) => api('/chat', { method: 'POST', body: JSON.stringify({ message }) }),
  switchCharacter: (name) => api('/switch', { method: 'POST', body: JSON.stringify({ name }) }),
  checkout: (hash) => api('/checkout', { method: 'POST', body: JSON.stringify({ hash }) }),
  reset: () => api('/reset', { method: 'POST' }),
};

/** Decode the host's base64 RGBA frames into ImageData[]. */
export function decodeFrames({ frames, width, height }) {
  return frames.map((b64) => {
    const s = atob(b64);
    const bytes = new Uint8ClampedArray(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new ImageData(bytes, width, height);
  });
}

/** PUA string → printable +XXXX escape listing (the string itself is invisible). */
export function unicodeEscapes(unicode) {
  return unicode.split('').map((c) => '\\u+' + c.codePointAt(0).toString(16)).join(' ');
}
