/**
 * Emoji host — the living-emoji interpreter, ported from the CombsMesh
 * demo (server.ts) and mounted under /api/emoji/*.
 *
 * THE HOST IS A DUMB INTERPRETER. All character logic lives INSIDE the
 * emoji's blocks (txt.specs/chr/orc/fnc/emo/tdo/lfc/api). Two characters
 * ship: spark-fox and nyx-owl — same host, different artifacts.
 *
 * Requires:
 *   COMBS_MESH_LIB    path to libcombsmesh_ffi.dylib (from CombsEngine)
 *   COMBS_ENGINE_URL  combs serve base URL (default http://127.0.0.1:8080)
 *   COMBS_HOME        registry dir (shared with the ecosystem by default)
 * When COMBS_MESH_LIB is missing the host degrades to 503 with setup
 * instructions — the rest of the platform is unaffected.
 */
import { base64Encode, Mesh } from "jsr:@combs/mesh@0.2.0";

const SERVE = Deno.env.get("COMBS_ENGINE_URL") || "http://127.0.0.1:8080";

// ---------- sprites (procedural RGBA, no assets) ----------

type Sprite = { rgba: number[]; w: number; h: number; frames: number };

function makeFox(): Sprite {
  const W = 64, H = 64, F = 4;
  const rgba = new Array(W * H * F * 4).fill(0);
  const put = (f: number, x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (f * W * H + y * W + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  };
  for (let f = 0; f < F; f++) {
    const bob = f % 2 === 0 ? 0 : 2, blink = f === 3, cx = 32, cy = 36 + bob;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - cx) / 20, dy = (y - cy) / 16;
      if (dx * dx + dy * dy <= 1) put(f, x, y, 232, 126, 44, 255);
    }
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (x > y && x + y < 30) {
        put(f, cx - 20 + x - 8, cy - 24 + y, 232, 126, 44, 255);
        put(f, cx + 20 - x + 8, cy - 24 + y, 232, 126, 44, 255);
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - cx) / 10, dy = (y - (cy + 7)) / 8;
      if (dx * dx + dy * dy <= 1) put(f, x, y, 250, 224, 190, 255);
    }
    const eyeY = cy - 4;
    for (const ex of [cx - 8, cx + 8]) {
      if (blink) { for (let x = -3; x <= 3; x++) put(f, ex + x, eyeY, 40, 26, 20, 255); }
      else {
        for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
          if (x * x + y * y <= 9) put(f, ex + x, eyeY + y, 40, 26, 20, 255);
        }
        put(f, ex + 1, eyeY - 1, 255, 255, 255, 255);
      }
    }
    put(f, cx, cy + 3, 40, 26, 20, 255);
    for (let x = -3; x <= 3; x++) put(f, cx + x, cy + 6 + Math.abs(x) - 3, 40, 26, 20, 200);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - (cx + 24)) / 8, dy = (y - (cy + 10)) / 6;
      if (dx * dx + dy * dy <= 1) put(f, x, y, 232, 126, 44, 255);
      const ddx = (x - (cx + 26)) / 3, ddy = (y - (cy + 8)) / 3;
      if (ddx * ddx + ddy * ddy <= 1) put(f, x, y, 250, 224, 190, 255);
    }
  }
  return { rgba, w: W, h: H, frames: F };
}

function makeOwl(): Sprite {
  const W = 64, H = 64, F = 4;
  const rgba = new Array(W * H * F * 4).fill(0);
  const put = (f: number, x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (f * W * H + y * W + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  };
  for (let f = 0; f < F; f++) {
    const bob = f % 2 === 0 ? 0 : 1, blink = f === 3, cx = 32, cy = 34 + bob;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - cx) / 18, dy = (y - cy) / 20;
      if (dx * dx + dy * dy <= 1) put(f, x, y, 104, 88, 180, 255);
    }
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      if (x > y) { put(f, cx - 14 + x - 5, cy - 22 + y, 104, 88, 180, 255); put(f, cx + 14 - x + 5, cy - 22 + y, 104, 88, 180, 255); }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - cx) / 9, dy = (y - (cy + 9)) / 10;
      if (dx * dx + dy * dy <= 1) put(f, x, y, 190, 180, 230, 255);
    }
    const eyeY = cy - 8;
    for (const ex of [cx - 8, cx + 8]) {
      for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) {
        if (x * x + y * y <= 25) put(f, ex + x, eyeY + y, 240, 238, 250, 255);
      }
      if (blink) { for (let x = -4; x <= 4; x++) put(f, ex + x, eyeY, 40, 30, 60, 255); }
      else {
        for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
          if (x * x + y * y <= 4) put(f, ex + x, eyeY + y, 40, 30, 60, 255);
        }
      }
    }
    put(f, cx, cy - 2, 240, 180, 60, 255); put(f, cx, cy - 1, 240, 180, 60, 255);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dl = (x - (cx - 16)) / 5, dr = (x - (cx + 16)) / 5, dy = (y - (cy + 6)) / 11;
      if (dl * dl + dy * dy <= 1 || dr * dr + dy * dy <= 1) put(f, x, y, 82, 68, 150, 255);
    }
  }
  return { rgba, w: W, h: H, frames: F };
}

// ---------- block-reading helpers (the interpreter's "ABI") ----------

type Block = Record<string, any>;

function blk(e: any, type: string): any {
  return (e.blocks as Block[]).find((b) => b.type === type);
}
function allSpecs(e: any): [string, string][] {
  return (e.blocks as Block[]).filter((b) => b.type === "txt").flatMap((b) => b.specs ?? []);
}
function spec(e: any, key: string, fallback = ""): string {
  const hit = allSpecs(e).find(([k]) => k === key);
  return hit ? hit[1] : fallback;
}
function specNum(e: any, key: string, fallback: number): number {
  const v = parseFloat(spec(e, key, ""));
  return Number.isFinite(v) ? v : fallback;
}
/** orc directives by key prefix → [{k: rest-of-key, v: value}] */
function orc(e: any, prefix: string): { k: string; v: string }[] {
  const o = blk(e, "orc");
  return (o?.directives ?? [])
    .filter((d: any) => d.key.startsWith(prefix))
    .map((d: any) => ({ k: d.key.slice(prefix.length), v: d.value }))
    .sort((a: { k: string }, b: { k: string }) => a.k.localeCompare(b.k));
}
function orcSet(e: any, key: string, value: string) {
  const o = blk(e, "orc")!;
  const hit = o.directives.find((d: any) => d.key === key);
  if (hit) hit.value = value;
  else o.directives.push({ kind: "Note", key, value });
}

// ---------- characters: ALL behavior declared in blocks ----------

function foxBlocks(sprite: Sprite): Block[] {
  return [
    { type: "txt", name: "spark-fox", description: "A mischievous fox sprite who lives in the mesh.", specs: [
      ["spec.version", "1"], ["species", "blob-fox"],
      ["sampler.temperature", "0.4"], ["sampler.max_tokens", "70"], ["sampler.frequency_penalty", "0.6"],
      ["tint.curious", "#f0a832"], ["tint.playful", "#3fb950"], ["tint.sleepy", "#58a6ff"],
    ] },
    { type: "img", name: "main", atlas: { width: sprite.w, height: sprite.h * sprite.frames, frame_width: sprite.w, frame_height: sprite.h, frame_count: sprite.frames, rgba: sprite.rgba } },
    { type: "chr", traits: [["mischievous", 0.8], ["loyal", 0.6], ["curious", 0.9]], backstory: "Hatched from a stray UDP packet. Collects shiny hashes. Afraid of firewalls." },
    { type: "emo", states: [{ name: "curious", intensity: 0.7 }, { name: "playful", intensity: 0.5 }, { name: "sleepy", intensity: 0.2 }] },
    { type: "tdo", items: [
      { key: "learn-name", value: "Learn the visitor's name", status: "Pending", depends_on: [] },
      { key: "play-game", value: "Get the visitor to play", status: "Pending", depends_on: [] },
      { key: "show-unicode", value: "Reveal unicode travel form", status: "Pending", depends_on: [] },
    ] },
    { type: "lfc", states: [{ name: "idle", initial: true }, { name: "active", initial: false }, { name: "sleeping", initial: false }],
      transitions: [{ from: "idle", to: "active", event: "greeted" }, { from: "active", to: "sleeping", event: "drowsy" }, { from: "sleeping", to: "active", event: "poke" }] },
    { type: "fnc", definitions: [
      { name: "add_todo", kind: "Add", params: ["value"], body: "track a new goal/task" },
      { name: "complete_todo", kind: "Update", params: ["key"], body: "mark a task done" },
      { name: "set_emotion", kind: "Update", params: ["name", "intensity"], body: "adjust an emotion (0..1)" },
    ] },
    { type: "orc", directives: [
      { kind: "Note", key: "persona.line.1", value: "You are Spark-Fox, a mischievous little blob-fox emoji who lives in a mesh network." },
      { kind: "Note", key: "persona.line.2", value: "Backstory: {{backstory}}" },
      { kind: "Note", key: "persona.line.3", value: "Current emotions: {{emotions}}. Current lifecycle state: {{lifecycle}}. Talking to: {{visitor}}." },
      { kind: "Note", key: "persona.line.4", value: "Stay in character as the fox at all times. Reply in 1-3 short sentences." },
      { kind: "Note", key: "persona.line.5", value: "Never mention being an AI, a language model, instructions, prompts, or emotions system." },
      { kind: "Note", key: "persona.line.6", value: "Let your current emotions color your tone (very sleepy = drowsy, very playful = excited)." },
      { kind: "Note", key: "persona.line.7", value: "You can change your own state by putting ACTION LINES at the end of your reply, one per line: [add_todo] task / [complete_todo] task words / [emotion] name 0.0-1.0. Only when clearly warranted, max 2." },
      { kind: "Note", key: "persona.line.8", value: "YOUR ACTIVE GOALS (you genuinely care — bring them up naturally): {{goals}}" },
      { kind: "Note", key: "shot.1.user", value: "hi" },
      { kind: "Note", key: "shot.1.assistant", value: "Hiya, new visitor! I'm Spark-Fox! Say — what's your name? I collect those, like shiny hashes." },
      { kind: "Note", key: "shot.2.user", value: "hey, remember to water the plants" },
      { kind: "Note", key: "shot.2.assistant", value: "Ooh, a shiny new task for my collection! I'll guard it well.\n[add_todo] water the plants" },
      { kind: "Note", key: "alias.add_todo", value: "add_todo|action|task|todo|remember|add_action" },
      { kind: "Note", key: "alias.complete_todo", value: "complete_todo|done|complete|completed|finish|completion" },
      { kind: "Note", key: "alias.emotion", value: "emotion|mood|feel" },
      { kind: "Note", key: "validate.task.min_words", value: "2" },
      { kind: "Note", key: "validate.task.max_len", value: "60" },
      { kind: "Note", key: "validate.task.stopwords", value: "now|let|lets|and|so|then|the|a|an|to|it|this|that|i|we|you|get|back|out|there|here" },
      { kind: "Note", key: "nlu.add.pattern", value: "(?:add|remember|track|remind me)\\s*(?:a\\s+|the\\s+)?(?:new\\s+)?(?:task|todo|goal|reminder)?\\s*(?:to|that|is)?\\s*(.+)" },
      { kind: "Note", key: "nlu.complete.pattern", value: "(done|completed|finished|did it|we did|taught you)" },
      { kind: "Note", key: "rule.emo.playful.up", value: "love|happy|great|awesome|cute|thanks|play|fun|yay|good:0.15" },
      { kind: "Note", key: "rule.emo.playful.down", value: "hate|sad|bad|stupid|angry|ugly|boring|dumb:0.2" },
      { kind: "Note", key: "rule.emo.sleepy.up", value: "sleep|tired|nap|night:0.25" },
      { kind: "Note", key: "rule.emo.sleepy.down", value: "play|fun|game:0.1" },
      { kind: "Note", key: "rule.question.up", value: "curious:0.1" },
      { kind: "Note", key: "rule.todo.learn-name.keywords", value: "my name is|i am |i'm " },
      { kind: "Note", key: "rule.todo.play-game.keywords", value: "play|game|fetch|ball" },
      { kind: "Note", key: "rule.todo.show-unicode.keywords", value: "unicode|travel|string|export" },
      { kind: "Note", key: "rule.lifecycle.on_greet", value: "active" },
      { kind: "Note", key: "rule.lifecycle.when.1", value: "sleepy>=0.7:sleeping" },
      { kind: "Note", key: "rule.lifecycle.when.2", value: "sleepy<0.5:active" },
      { kind: "Note", key: "state.current", value: "idle" },
      { kind: "Note", key: "anim.event.thinking", value: "?" },
      { kind: "Note", key: "anim.event.aha", value: "!" },
      { kind: "Note", key: "anim.event.celebrate", value: "✨" },
      { kind: "Note", key: "anim.state.sleeping", value: "💤" },
      { kind: "Note", key: "nlu.name.pattern", value: "(?:my name is|i am|i'm|im)\\s+([a-z]{2,})" },
      { kind: "Note", key: "nlu.name.not_names", value: "exciting|excited|happy|sad|tired|good|fine|ok|okay|sure|ready|done|here|there|sleepy|hungry|bored|angry|sorry|busy|alive|back|new|not|so|very|really|just|also|glad|great|awesome|cool" },
    ] },
  ];
}

function owlBlocks(sprite: Sprite): Block[] {
  return [
    { type: "txt", name: "nyx-owl", description: "A drowsy night-owl archivist of the mesh.", specs: [
      ["spec.version", "1"], ["species", "night-owl"],
      ["sampler.temperature", "0.5"], ["sampler.max_tokens", "60"], ["sampler.frequency_penalty", "0.6"],
      ["tint.drowsy", "#7c6ff0"], ["tint.wise", "#58a6ff"], ["tint.grumpy", "#f06868"],
    ] },
    { type: "img", name: "main", atlas: { width: sprite.w, height: sprite.h * sprite.frames, frame_width: sprite.w, frame_height: sprite.h, frame_count: sprite.frames, rgba: sprite.rgba } },
    { type: "chr", traits: [["drowsy", 0.7], ["wise", 0.8], ["grumpy", 0.3]], backstory: "Once archived an entire datacenter by moonlight. Speaks in quiet, measured tones. Calls every visitor 'hatchling'. Forgets nothing, forgives loud noises never." },
    { type: "emo", states: [{ name: "drowsy", intensity: 0.6 }, { name: "wise", intensity: 0.4 }, { name: "grumpy", intensity: 0.2 }] },
    { type: "tdo", items: [
      { key: "catalog-name", value: "Catalog the visitor's name in the archive", status: "Pending", depends_on: [] },
      { key: "share-secret", value: "Share one night-secret", status: "Pending", depends_on: [] },
      { key: "stay-awake", value: "Stay awake through the conversation", status: "Pending", depends_on: [] },
    ] },
    { type: "lfc", states: [{ name: "dozing", initial: true }, { name: "perching", initial: false }, { name: "hunting", initial: false }],
      transitions: [{ from: "dozing", to: "perching", event: "disturbed" }, { from: "perching", to: "dozing", event: "lull" }, { from: "perching", to: "hunting", event: "provoked" }, { from: "hunting", to: "perching", event: "settled" }] },
    { type: "fnc", definitions: [
      { name: "add_todo", kind: "Add", params: ["value"], body: "inscribe a new entry in the archive" },
      { name: "complete_todo", kind: "Update", params: ["key"], body: "seal an archive entry as done" },
      { name: "set_emotion", kind: "Update", params: ["name", "intensity"], body: "shift the night's temper (0..1)" },
    ] },
    { type: "orc", directives: [
      { kind: "Note", key: "persona.line.1", value: "You are Nyx, an ancient night-owl emoji, archivist of the mesh." },
      { kind: "Note", key: "persona.line.2", value: "Backstory: {{backstory}}" },
      { kind: "Note", key: "persona.line.3", value: "Current emotions: {{emotions}}. Current posture: {{lifecycle}}. Visitor before you: {{visitor}}." },
      { kind: "Note", key: "persona.line.4", value: "Speak in quiet, measured, slightly weary tones. Address the visitor as 'hatchling'. Reply in 1-3 short sentences." },
      { kind: "Note", key: "persona.line.5", value: "Never mention being an AI, a language model, instructions, prompts, or emotions system." },
      { kind: "Note", key: "persona.line.6", value: "When drowsy, yawn with words. When grumpy, be curt. When wise, offer small nocturnal wisdom." },
      { kind: "Note", key: "persona.line.7", value: "You may inscribe changes to your archive by putting ACTION LINES at the end of your reply, one per line: [add_todo] entry / [complete_todo] entry words / [emotion] name 0.0-1.0. Only when clearly warranted, max 2." },
      { kind: "Note", key: "persona.line.8", value: "OPEN ARCHIVE ENTRIES (an archivist finishes what it files — pursue these gently): {{goals}}" },
      { kind: "Note", key: "shot.1.user", value: "hello?" },
      { kind: "Note", key: "shot.1.assistant", value: "Mmm. A hatchling stirs my archive... *ruffles feathers* State your name, little one — everything must be catalogued." },
      { kind: "Note", key: "shot.2.user", value: "note down that I should feed the cat" },
      { kind: "Note", key: "shot.2.assistant", value: "*scratches quill* Filed under domestic obligations, hatchling.\n[add_todo] feed the cat" },
      { kind: "Note", key: "alias.add_todo", value: "add_todo|action|task|todo|remember|note|inscribe|file" },
      { kind: "Note", key: "alias.complete_todo", value: "complete_todo|done|complete|completed|finish|seal|filed" },
      { kind: "Note", key: "alias.emotion", value: "emotion|mood|feel|temper" },
      { kind: "Note", key: "validate.task.min_words", value: "2" },
      { kind: "Note", key: "validate.task.max_len", value: "60" },
      { kind: "Note", key: "validate.task.stopwords", value: "now|let|lets|and|so|then|the|a|an|to|it|this|that|i|we|you|get|back|out|there|here" },
      { kind: "Note", key: "nlu.add.pattern", value: "(?:add|remember|track|remind me|note down|note|catalog|file)\\s*(?:a\\s+|the\\s+)?(?:new\\s+)?(?:task|todo|goal|reminder|entry)?\\s*(?:to|that|is)?\\s*(.+)" },
      { kind: "Note", key: "nlu.complete.pattern", value: "(done|completed|finished|did it|we did|filed)" },
      { kind: "Note", key: "rule.emo.drowsy.up", value: "sleep|tired|nap|night|boring|quiet:0.2" },
      { kind: "Note", key: "rule.emo.drowsy.down", value: "wake|morning|fun|play|secret:0.15" },
      { kind: "Note", key: "rule.emo.grumpy.up", value: "hate|loud|stupid|shut|angry|annoying|noise:0.2" },
      { kind: "Note", key: "rule.emo.wise.up", value: "why|how|what|secret|story|wisdom|learn:0.15" },
      { kind: "Note", key: "rule.question.up", value: "wise:0.1" },
      { kind: "Note", key: "rule.todo.catalog-name.keywords", value: "my name is|i am |i'm " },
      { kind: "Note", key: "rule.todo.share-secret.keywords", value: "secret|tell me something|story" },
      { kind: "Note", key: "rule.lifecycle.on_greet", value: "perching" },
      { kind: "Note", key: "rule.lifecycle.when.1", value: "drowsy>=0.85:dozing" },
      { kind: "Note", key: "rule.lifecycle.when.2", value: "grumpy>=0.7:hunting" },
      { kind: "Note", key: "rule.lifecycle.when.3", value: "drowsy<0.6:perching" },
      { kind: "Note", key: "state.current", value: "dozing" },
      { kind: "Note", key: "anim.event.thinking", value: "?" },
      { kind: "Note", key: "anim.event.aha", value: "!" },
      { kind: "Note", key: "anim.event.celebrate", value: "📜" },
      { kind: "Note", key: "anim.state.dozing", value: "💤" },
      { kind: "Note", key: "anim.state.hunting", value: "‼" },
      { kind: "Note", key: "nlu.name.pattern", value: "(?:my name is|i am|i'm|im|call me)\\s+([a-z]{2,})" },
      { kind: "Note", key: "nlu.name.not_names", value: "exciting|excited|happy|sad|tired|good|fine|ok|okay|sure|ready|done|here|there|sleepy|hungry|bored|angry|sorry|busy|alive|back|new|not|so|very|really|just|also|glad|great|awesome|cool" },
    ] },
  ];
}

// ---------- generic interpreter (character-agnostic) ----------

interface Character {
  emoji: any;
  binary: Uint8Array;
  chain: { hash: string; note: string; turn: number }[];
  history: { role: string; content: string }[];
  turn: number;
}

let mesh: Mesh | null = null;
let chars: Record<string, Character> | null = null;
let current = "spark-fox";

/** Lazily open the FFI + register both characters on first request, so
 *  the platform boots fine without COMBS_MESH_LIB. */
function ensureHost(): Record<string, Character> {
  if (chars) return chars;
  if (!Deno.env.get("COMBS_MESH_LIB")) {
    throw new Error(
      "emoji host disabled: set COMBS_MESH_LIB to libcombsmesh_ffi.dylib (build it in CombsEngine: cargo xtask build --release)",
    );
  }
  mesh = Mesh.open();
  mesh.init();
  const register = (name: string, blocks: Block[]): Character => {
    const built = mesh!.buildEmoji({ name, blocks });
    const hash = mesh!.registryRegister(built.binary, name);
    return {
      emoji: built.emoji, binary: built.binary, turn: 0, history: [],
      chain: [{ hash, note: `genesis: ${name} registered`, turn: 0 }],
    };
  };
  chars = {
    "spark-fox": register("spark-fox", foxBlocks(makeFox())),
    "nyx-owl": register("nyx-owl", owlBlocks(makeOwl())),
  };
  return chars;
}

const C = (): Character => ensureHost()[current];
const lifecycle = (c: Character) => orc(c.emoji, "state.current")[0]?.v ?? "idle";

function dominantEmotion(e: any): string {
  const states = blk(e, "emo")!.states as { name: string; intensity: number }[];
  return states.reduce((a, b) => (b.intensity > a.intensity ? b : a)).name;
}

function fill(template: string, c: Character): string {
  const e = c.emoji;
  const goals = (blk(e, "tdo").items as any[]).filter((i) => i.status !== "Done").map((i) => i.value).join("; ") || "all complete";
  const visitor = orc(e, "visitor.name")[0]?.v ?? "a new visitor (name unknown)";
  return template
    .replaceAll("{{backstory}}", blk(e, "chr").backstory)
    .replaceAll("{{emotions}}", (blk(e, "emo").states as any[]).map((s) => `${s.name} ${s.intensity}`).join(", "))
    .replaceAll("{{lifecycle}}", lifecycle(c))
    .replaceAll("{{visitor}}", visitor)
    .replaceAll("{{goals}}", goals);
}

function personaPrompt(c: Character): string {
  return orc(c.emoji, "persona.line.").map((l) => fill(l.v, c)).join("\n");
}

function fewShot(c: Character): { role: string; content: string }[] {
  const shots: { role: string; content: string }[] = [];
  const users = orc(c.emoji, "shot.");
  const byN: Record<string, Record<string, string>> = {};
  for (const { k, v } of users) {
    const [n, part] = k.split(".");
    (byN[n] ??= {})[part] = v;
  }
  for (const n of Object.keys(byN).sort()) {
    if (byN[n].user) shots.push({ role: "user", content: byN[n].user });
    if (byN[n].assistant) shots.push({ role: "assistant", content: byN[n].assistant });
  }
  return shots;
}

function setEmo(c: Character, name: string, delta: number, t: string[], abs?: number) {
  const s = (blk(c.emoji, "emo").states as any[]).find((x) => x.name === name);
  if (!s) return;
  const next = Math.min(1, Math.max(0, +(abs ?? s.intensity + delta).toFixed(2)));
  if (next !== s.intensity) { t.push(`emo ${name} ${s.intensity}→${next}`); s.intensity = next; }
}

function fireLifecycle(c: Character, to: string, event: string, t: string[]) {
  const from = lifecycle(c);
  if (from === to) return;
  const legal = (blk(c.emoji, "lfc").transitions as any[]).some((tr) => tr.from === from && tr.to === to);
  if (!legal) return;
  orcSet(c.emoji, "state.current", to);
  t.push(`lfc ${from}→${to} (${event})`);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-") || "task";
}

function saneTask(c: Character, arg: string): boolean {
  const words = arg.split(/\s+/).filter(Boolean);
  const stop = orc(c.emoji, "validate.task.stopwords")[0]?.v.split("|") ?? [];
  const minWords = parseInt(orc(c.emoji, "validate.task.min_words")[0]?.v ?? "2");
  const maxLen = parseInt(orc(c.emoji, "validate.task.max_len")[0]?.v ?? "60");
  return arg.length >= 3 && arg.length <= maxLen && /[a-z]/i.test(arg) &&
    !arg.includes("?") && words.length >= minWords && !stop.some((s) => s.toLowerCase() === words[0].toLowerCase());
}

function completeTodo(c: Character, key: string, t: string[], via: string) {
  const item = (blk(c.emoji, "tdo").items as any[]).find((x) => x.key === key && x.status !== "Done");
  if (item) { item.status = "Done"; t.push(`tdo ${key} → Done (${via})`); }
}

function addTodo(c: Character, value: string, t: string[], via: string) {
  const items = blk(c.emoji, "tdo").items as any[];
  const key = slugify(value);
  if (saneTask(c, value) && items.length < 8 && !items.some((i) => i.key === key || i.value.toLowerCase() === value.toLowerCase())) {
    items.push({ key, value, status: "Pending", depends_on: [] });
    t.push(`tdo ${key} added (${via})`);
  }
}

/** Extract + remember the visitor's name (first real memory). */
function detectName(c: Character, m: string, t: string[]): void {
  if (orc(c.emoji, "visitor.name")[0]) return;
  const pat = orc(c.emoji, "nlu.name.pattern")[0]?.v;
  if (!pat) return;
  const hit = m.match(new RegExp(pat));
  if (!hit?.[1]) return;
  const candidate = hit[1];
  const notNames = orc(c.emoji, "nlu.name.not_names")[0]?.v.split("|") ?? [];
  if (notNames.includes(candidate)) return;
  const name = candidate[0].toUpperCase() + candidate.slice(1);
  orcSet(c.emoji, "visitor.name", name);
  t.push(`memory visitor.name = ${name}`);
  for (const item of blk(c.emoji, "tdo").items as any[]) {
    if (item.key.toLowerCase().includes("name") && item.status !== "Done") {
      item.status = "Done";
      t.push(`tdo ${item.key} → Done (reflex)`);
    }
  }
}

/** Emoji-declared heuristic rules — the character's reflexes. */
function interpret(c: Character, message: string): string[] {
  const t: string[] = [];
  const e = c.emoji;
  const m = message.toLowerCase();
  const greet = orc(e, "rule.lifecycle.on_greet")[0]?.v;
  const initial = (blk(e, "lfc").states as any[]).find((s) => s.initial)?.name;
  if (greet && lifecycle(c) === initial) fireLifecycle(c, greet, "greeted", t);

  for (const { k, v } of orc(e, "rule.emo.")) {
    const [name, dir] = k.split(".");
    const [words, deltaS] = v.split(":");
    const delta = parseFloat(deltaS);
    if (!Number.isFinite(delta)) continue;
    if (words.split("|").some((w) => m.includes(w))) setEmo(c, name, dir === "up" ? delta : -delta, t);
  }
  if (m.includes("?")) {
    const q = orc(e, "rule.question.up")[0]?.v.split(":");
    if (q) setEmo(c, q[0], parseFloat(q[1]), t);
  }
  for (const { k, v } of orc(e, "rule.todo.")) {
    const key = k.replace(/\.keywords$/, "");
    if (v.split("|").some((w) => m.includes(w))) {
      if (key.toLowerCase().includes("name")) detectName(c, m, t);
      else completeTodo(c, key, t, "reflex");
    }
  }
  detectName(c, m, t);
  const addPat = orc(e, "nlu.add.pattern")[0]?.v;
  if (addPat) {
    const hit = m.match(new RegExp(addPat));
    if (hit?.[1]) addTodo(c, hit[1].trim(), t, "host NLU");
  }
  const compPat = orc(e, "nlu.complete.pattern")[0]?.v;
  if (compPat && m.match(new RegExp(compPat))) {
    const items = blk(e, "tdo").items as any[];
    const hit = items.find((i: any) => i.status !== "Done" &&
      i.value.toLowerCase().split(/\s+/).some((w: string) => w.length > 4 && m.includes(w)));
    if (hit) { hit.status = "Done"; t.push(`tdo ${hit.key} → Done (host NLU)`); }
  }
  for (const { v } of orc(e, "rule.lifecycle.when.")) {
    const [cond, to] = v.split(":");
    const mm = cond.match(/([a-z]+)\s*(>=|<)\s*([\d.]+)/);
    if (!mm) continue;
    const s = (blk(e, "emo").states as any[]).find((x) => x.name === mm[1]);
    if (!s) continue;
    const val = parseFloat(mm[3]);
    if ((mm[2] === ">=" && s.intensity >= val) || (mm[2] === "<" && s.intensity < val)) {
      fireLifecycle(c, to, `${mm[1]} ${mm[2]} ${val}`, t);
    }
  }
  return t;
}

/** fnc channel: LLM proposes action lines; aliases + validation from blocks. */
function applyActions(c: Character, reply: string, t: string[]): string {
  const aliases: Record<string, string[]> = {};
  for (const canon of ["add_todo", "complete_todo", "emotion"]) {
    aliases[canon] = orc(c.emoji, `alias.${canon}`)[0]?.v.split("|") ?? [canon];
  }
  const variant = (word: string): string | undefined =>
    Object.entries(aliases).find(([, vs]) => vs.includes(word))?.[0];
  const re = /\[\s*([a-z_ ]+?)\s*\]\s*["']?([^"'\[\]\n]*)["']?/gi;
  let applied = 0;
  let visible = reply;
  for (const m of reply.matchAll(re)) {
    const op = variant(m[1].trim().toLowerCase().replace(/\s+/g, "_"));
    if (!op) continue;
    visible = visible.replace(m[0], " ");
    if (applied >= 2) continue;
    const arg = m[2].trim();
    if (!arg) continue;
    if (op === "add_todo") { addTodo(c, arg, t, "LLM fnc"); applied++; }
    else if (op === "complete_todo") {
      const items = blk(c.emoji, "tdo").items as any[];
      const hit = items.find((i) => i.status !== "Done" &&
        (i.key === slugify(arg) || i.value.toLowerCase().includes(arg.toLowerCase())));
      if (hit) { hit.status = "Done"; t.push(`fnc complete_todo(${hit.key}) — proposed by LLM`); applied++; }
    } else if (op === "emotion") {
      const parts = arg.split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      const name = parts.slice(0, -1).join(" ").toLowerCase();
      if (Number.isFinite(val)) { setEmo(c, name, 0, t, val); applied++; }
    }
  }
  return visible.replace(/\s{2,}/g, " ").replace(/\[[a-z_ ]*$/i, "").trim() || "…";
}

async function llmReply(c: Character, message: string): Promise<string> {
  c.history.push({ role: "user", content: message });
  while (c.history.length > 12) c.history.shift();
  const e = c.emoji;
  const res = await fetch(`${SERVE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "system", content: personaPrompt(c) }, ...fewShot(c), ...c.history],
      max_tokens: specNum(e, "sampler.max_tokens", 70),
      temperature: specNum(e, "sampler.temperature", 0.4),
      frequency_penalty: specNum(e, "sampler.frequency_penalty", 0.6),
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`combs serve ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "...";
}

async function commitVersion(c: Character, note: string): Promise<string> {
  const rebuilt = mesh!.buildEmoji({ name: c.emoji.name, blocks: c.emoji.blocks as never[] });
  c.emoji = rebuilt.emoji;
  c.binary = rebuilt.binary;
  const hash = mesh!.registryRegister(c.binary, c.emoji.name);
  c.chain.push({ hash, note, turn: c.turn });
  return hash;
}

const statePayload = (c: Character) => ({
  emoji: c.emoji, lifecycle: lifecycle(c), dominant: dominantEmotion(c.emoji),
  turn: c.turn, chain: c.chain, current,
  characters: Object.keys(ensureHost()),
  anim: Object.fromEntries(orc(c.emoji, "anim.").map(({ k, v }) => [k, v])),
  spec: {
    tints: Object.fromEntries(allSpecs(c.emoji).filter(([k]) => k.startsWith("tint.")).map(([k, v]) => [k.slice(5), v])),
    name: spec(c.emoji, "species", c.emoji.name),
  },
});

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** Router for /api/emoji/* — session gating happens in main.ts. */
export async function handleEmoji(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/emoji/, "") || "/";
  try {
    const c = C(); // ensures host (throws a helpful 500 when dylib missing)

    if (path === "/state") return json(statePayload(c));
    if (path === "/switch" && req.method === "POST") {
      const { name } = await req.json();
      if (!ensureHost()[name]) return json({ error: `unknown character ${name}` }, 404);
      current = name;
      return json(statePayload(C()));
    }
    if (path === "/frames") {
      const frames = [];
      const count = blk(c.emoji, "img").atlas.frame_count;
      for (let i = 0; i < count; i++) frames.push(base64Encode(mesh!.renderSprite(c.binary, i).rgba));
      return json({ frames, width: blk(c.emoji, "img").atlas.frame_width, height: blk(c.emoji, "img").atlas.frame_height });
    }
    if (path === "/unicode") {
      const unicode = mesh!.toUnicode(c.emoji);
      const back = mesh!.fromUnicode(unicode);
      return json({ unicode, chars: unicode.length, verified: JSON.stringify(back) === JSON.stringify(c.emoji) });
    }
    if (path === "/checkout" && req.method === "POST") {
      const { hash } = await req.json();
      const entry = c.chain.find((x) => x.hash === hash || x.hash.startsWith(String(hash)));
      if (!entry) return json({ error: `hash ${hash} not in this chain` }, 404);
      const resolved = mesh!.registryResolve(entry.hash);
      c.emoji = resolved.emoji;
      c.binary = resolved.binary;
      c.chain.push({ hash: entry.hash, note: `⏪ checked out (branch from t${entry.turn})`, turn: c.turn });
      return json({ restored: entry.hash, ...statePayload(c) });
    }
    if (path === "/reset" && req.method === "POST") {
      const factory = current === "nyx-owl" ? owlBlocks : foxBlocks;
      const sprite = current === "nyx-owl" ? makeOwl() : makeFox();
      const name = current;
      const built = mesh!.buildEmoji({ name, blocks: factory(sprite) });
      const hash = mesh!.registryRegister(built.binary, name);
      ensureHost()[current] = {
        emoji: built.emoji, binary: built.binary, turn: 0, history: [],
        chain: [{ hash, note: `genesis: ${name} registered`, turn: 0 }],
      };
      return json({ restarted: current, ...statePayload(C()) });
    }
    if (path === "/chat" && req.method === "POST") {
      const { message } = await req.json();
      if (typeof message !== "string" || !message.trim()) return json({ error: "message required" }, 400);
      c.turn++;
      const raw = await llmReply(c, message);
      const transitions = interpret(c, message);
      const reply = applyActions(c, raw, transitions);
      c.history.push({ role: "assistant", content: reply });
      const hash = await commitVersion(c, transitions.join(" · ") || "turn: no state change");
      const celebrate = transitions.some((x) => /Done|added|memory/.test(x));
      const aha = !celebrate && transitions.length > 0;
      return json({ reply, transitions, hash, celebrate, aha, ...statePayload(c) });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    const message = (e as Error).message;
    const status = message.startsWith("emoji host disabled") ? 503 : 500;
    return json({ error: message }, status);
  }
}
