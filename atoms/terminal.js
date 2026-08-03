// ============================================================
// Terminal: captures console output (including the WASM engine logs,
// which Emscripten routes through console.log/warn) plus uncaught
// errors, and renders them in a terminal-style panel. Errors raise a
// red badge on the header icon until the panel is opened.
// Capture starts at module import; UI wiring in initTerminal().
// ============================================================
import {
  terminalBtn, terminalBadge, terminalModal, terminalModalClose,
  terminalOutput, terminalClear, terminalDone
} from './dom.js';

const MAX_LINES = 300;
const entries = [];
let unseenErrors = 0;
let isOpen = false;

function serialize(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function fmtTime(d) {
  return d.toTimeString().slice(0, 8);
}

function updateBadge() {
  terminalBadge.textContent = unseenErrors > 99 ? '99+' : String(unseenErrors);
  terminalBadge.classList.toggle('hidden', unseenErrors === 0);
}

function appendLine(entry, autoscroll) {
  const line = document.createElement('div');
  line.className = `terminal-line ${entry.level}`;
  const time = document.createElement('span');
  time.className = 'terminal-time';
  time.textContent = fmtTime(entry.time);
  const text = document.createElement('span');
  text.className = 'terminal-text';
  text.textContent = entry.text;
  line.append(time, text);
  terminalOutput.appendChild(line);
  if (autoscroll) terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function addEntry(level, text) {
  const entry = { level, text, time: new Date() };
  entries.push(entry);
  if (entries.length > MAX_LINES) entries.shift();
  if (level === 'error' && !isOpen) {
    unseenErrors++;
    updateBadge();
  }
  if (isOpen) appendLine(entry, true);
}

// ---- Capture (module scope: starts as soon as this file is imported) ----
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    addEntry(level, serialize(args));
    original(...args);
  };
}
window.addEventListener('error', (e) => {
  addEntry('error', `${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener('unhandledrejection', (e) => {
  addEntry('error', `Unhandled rejection: ${serialize([e.reason])}`);
});

// ---- Panel behavior ----
function renderAll() {
  terminalOutput.innerHTML = '';
  for (const entry of entries) appendLine(entry, false);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function openTerminal() {
  isOpen = true;
  unseenErrors = 0;
  updateBadge();
  renderAll();
  terminalModal.classList.remove('hidden');
}

export function closeTerminal() {
  isOpen = false;
  terminalModal.classList.add('hidden');
}

export function initTerminal() {
  terminalBtn.addEventListener('click', openTerminal);
  terminalModalClose.addEventListener('click', closeTerminal);
  terminalDone.addEventListener('click', closeTerminal);
  terminalClear.addEventListener('click', () => {
    entries.length = 0;
    renderAll();
  });
  terminalModal.addEventListener('click', (e) => {
    if (e.target === terminalModal) closeTerminal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !terminalModal.classList.contains('hidden')) {
      closeTerminal();
    }
  });
}
