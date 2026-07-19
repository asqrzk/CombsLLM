// ============================================================
// Prompt builders for the tasks-genai backend. That runtime keeps no
// conversation state and applies no chat template, so the full prompt
// is rebuilt from the message log on every send. Media parts ride as
// { imageSource } / { audioSource } objects; the runtime expands them
// into the model's media tokens + encoder embeddings.
// ============================================================
import { contentToText, compressToCaveman } from './text.js';
import { dataUrlToMonoAudioBuffer } from './audio.js';

export async function buildPrompt(log, useCaveman, format) {
  return format === 'gemma3' ? buildGemma3Prompt(log, useCaveman) : buildGemma4Prompt(log, useCaveman);
}

async function pushMediaPart(parts, part, padding) {
  if (part.type === 'image' && part.dataUrl) {
    parts.push(padding, { imageSource: part.dataUrl }, padding);
  } else if (part.type === 'audio' && part.dataUrl) {
    const buffer = await dataUrlToMonoAudioBuffer(part.dataUrl);
    parts.push(padding, { audioSource: buffer }, padding);
  }
}

// Gemma 4 format: <|turn>role ... <turn|>
async function buildGemma4Prompt(log, useCaveman) {
  const parts = [];
  const cx = (t) => (useCaveman ? compressToCaveman(t) : t);
  const sys = log.find(m => m.role === 'system');
  if (sys) {
    parts.push('<|turn>system\n', contentToText(sys.content).trim(), '<turn|>\n');
  }
  for (const m of log) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    parts.push(`<|turn>${role}\n`);
    if (typeof m.content === 'string') {
      parts.push(cx(m.content));
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') parts.push(cx(part.text));
        else await pushMediaPart(parts, part, '\n\n');
      }
    }
    parts.push('<turn|>\n');
  }
  parts.push('<|turn>model\n');
  return parts;
}

// Classic Gemma format (<start_of_turn>) used by Gemma-3n. Gemma-3n has no
// system turn, so the system preface is merged into the first user turn.
async function buildGemma3Prompt(log, useCaveman) {
  const parts = [];
  const cx = (t) => (useCaveman ? compressToCaveman(t) : t);
  const sysMsg = log.find(m => m.role === 'system');
  const sysText = sysMsg ? contentToText(sysMsg.content).trim() : '';
  let sysPending = sysText.length > 0;
  for (const m of log) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    parts.push(`<start_of_turn>${role}\n`);
    if (role === 'user' && sysPending) {
      parts.push(sysText, '\n\n');
      sysPending = false;
    }
    if (typeof m.content === 'string') {
      parts.push(cx(m.content));
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') parts.push(cx(part.text));
        else await pushMediaPart(parts, part, '\n');
      }
    }
    parts.push('<end_of_turn>\n');
  }
  parts.push('<start_of_turn>model\n');
  return parts;
}
