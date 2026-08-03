// ============================================================
// Audio pipeline: microphone recording (MediaRecorder) and decoding
// to mono 16 kHz AudioBuffers for the tasks-genai runtime.
// Recordings are stored in the message log as base64 data URLs.
// ============================================================

const DEFAULT_SAMPLE_RATE = 16000; // Gemma audio encoder input rate

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let recordingStartedAt = 0;

export function isRecording() {
  return !!mediaRecorder;
}

export async function startAudioRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
  recordingStartedAt = performance.now();
  mediaRecorder.start();
}

export function stopAudioRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder) return reject(new Error('No active recording.'));
    const recorder = mediaRecorder;
    recorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' });
      const duration = (performance.now() - recordingStartedAt) / 1000;
      mediaStream.getTracks().forEach(t => t.stop());
      mediaRecorder = null;
      mediaStream = null;
      resolve({ blob, duration });
    };
    recorder.onerror = (e) => reject(e.error || new Error('Recording failed.'));
    recorder.stop();
  });
}

// Decode any browser-supported audio blob and resample to mono at the
// target rate. OfflineAudioContext with 1 channel performs the mixdown.
export async function blobToMonoAudioBuffer(blob, sampleRate = DEFAULT_SAMPLE_RATE) {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  try {
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * sampleRate), sampleRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    return await offline.startRendering();
  } finally {
    decodeCtx.close();
  }
}

export async function dataUrlToMonoAudioBuffer(dataUrl, sampleRate = DEFAULT_SAMPLE_RATE) {
  const blob = await (await fetch(dataUrl)).blob();
  return blobToMonoAudioBuffer(blob, sampleRate);
}
