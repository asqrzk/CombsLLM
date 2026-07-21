// ============================================================
// LiteRT.js backend (@litertjs/core) for classic single-graph
// .tflite models. These models consume tensors, not chat messages:
// send() takes the attached image, preprocesses it to the model's
// input tensor, runs one inference, and formats the top-5 scores.
// ============================================================

const LITERTJS_VERSION = '2.5.3';
const LITERTJS_ESM = `https://cdn.jsdelivr.net/npm/@litertjs/core@${LITERTJS_VERSION}/+esm`;
const LITERTJS_WASM_ROOT = `https://cdn.jsdelivr.net/npm/@litertjs/core@${LITERTJS_VERSION}/wasm/`;

const NO_IMAGE_MESSAGE = 'This is a classic `.tflite` model — attach an image and send to run inference. Text prompting does not apply to this runtime.';

let liteRtModule = null;
let liteRtReady = null;

// The LiteRT.js runtime is a global WASM instance; load it once and share it.
// JSPI is only needed to bridge async WebNN drivers.
async function ensureRuntime(useWebnn) {
  if (!liteRtModule) liteRtModule = await import(LITERTJS_ESM);
  if (!liteRtReady) {
    liteRtReady = liteRtModule.loadLiteRt(LITERTJS_WASM_ROOT, useWebnn ? { jspi: true } : undefined);
  }
  await liteRtReady;
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

export class LitertJsBackend {
  constructor() {
    this.kind = 'litertjs';
    this.model = null;
    this.labels = null;
  }

  async mount(modelDef, modelUrl, { accelerator = 'webgpu' } = {}) {
    await ensureRuntime(accelerator === 'webnn');
    this.model = await liteRtModule.loadAndCompile(modelUrl, { accelerator });
    if (modelDef.labelsFile) {
      try {
        const labelsUrl = `https://huggingface.co/${modelDef.repo}/resolve/main/${modelDef.labelsFile}`;
        this.labels = (await (await fetch(labelsUrl)).text())
          .split('\n').map(s => s.trim()).filter(Boolean);
      } catch {
        this.labels = null; // fall back to class indices
      }
    }
  }

  // Stateless single-shot inference — no conversation context.
  async resetContext() {}

  // Resize the image to the model's input shape and build the input tensor.
  async preprocess(dataUrl) {
    const details = this.model.getInputDetails()[0];
    const shape = Array.from(details.shape);
    const isNchw = shape.length === 4 && shape[1] === 3;
    const h = isNchw ? shape[2] : shape[1];
    const w = isNchw ? shape[3] : shape[2];

    const bitmap = await dataUrlToBitmap(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, w, h).data;

    const pixels = w * h;
    if (details.dtype === 'uint8') {
      const data = new Uint8Array(pixels * 3);
      for (let i = 0; i < pixels; i++) {
        data[i * 3] = rgba[i * 4];
        data[i * 3 + 1] = rgba[i * 4 + 1];
        data[i * 3 + 2] = rgba[i * 4 + 2];
      }
      return new liteRtModule.Tensor(data, shape);
    }

    // float32 input with standard TF normalization: (x - 127.5) / 127.5
    const data = new Float32Array(pixels * 3);
    if (isNchw) {
      for (let i = 0; i < pixels; i++) {
        data[i] = (rgba[i * 4] - 127.5) / 127.5;
        data[pixels + i] = (rgba[i * 4 + 1] - 127.5) / 127.5;
        data[2 * pixels + i] = (rgba[i * 4 + 2] - 127.5) / 127.5;
      }
    } else {
      for (let i = 0; i < pixels; i++) {
        data[i * 3] = (rgba[i * 4] - 127.5) / 127.5;
        data[i * 3 + 1] = (rgba[i * 4 + 1] - 127.5) / 127.5;
        data[i * 3 + 2] = (rgba[i * 4 + 2] - 127.5) / 127.5;
      }
    }
    return new liteRtModule.Tensor(data, shape);
  }

  async formatResults(outputs) {
    const out = outputs[0];
    const scores = await out.data();
    const isQuantized = scores instanceof Uint8Array;
    const indexed = Array.from(scores, (v, i) => ({ i, v: isQuantized ? v / 255 : v }));
    indexed.sort((a, b) => b.v - a.v);
    const top = indexed.slice(0, 5);
    const lines = top.map((t, n) => {
      const label = this.labels?.[t.i] || `class ${t.i}`;
      return `${n + 1}. **${label}** — ${(t.v * 100).toFixed(1)}%`;
    });
    return `**Inference results** (top 5)\n\n${lines.join('\n')}`;
  }

  async send(content, _opts = {}, onText) {
    const parts = Array.isArray(content) ? content : [];
    const imagePart = parts.find(p => p.type === 'image' && p.dataUrl);
    if (!imagePart) {
      onText(NO_IMAGE_MESSAGE);
      return NO_IMAGE_MESSAGE;
    }

    const inputTensor = await this.preprocess(imagePart.dataUrl);
    let outputs = [];
    try {
      outputs = await this.model.run([inputTensor]);
      const text = await this.formatResults(outputs);
      onText(text);
      return text;
    } finally {
      inputTensor.delete();
      outputs.forEach(o => o.delete());
    }
  }

  async dispose() {
    if (this.model) {
      this.model.delete();
      this.model = null;
    }
    this.labels = null;
  }
}
