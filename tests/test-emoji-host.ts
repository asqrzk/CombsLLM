// Live verification for server/emoji.ts — calls handleEmoji directly
// (bypasses the session gate, which is covered by Phase 3 curl checks).
// Requires: COMBS_MESH_LIB, COMBS_ENGINE_URL (a running combs serve).
// deno task test:emoji
import { handleEmoji } from "../server/emoji.ts";

function req(path: string, body?: unknown): Request {
  return new Request(`http://localhost:8787/api/emoji${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
}

const state = await (await handleEmoji(req("/state"), new URL("http://x/api/emoji/state"))).json();
check("state has spark-fox", state.emoji?.name === "spark-fox");
check("chain starts at genesis", state.chain?.length === 1 && state.chain[0].note.includes("genesis"));
check("two characters registered", (state.characters ?? []).length === 2);

const frames = await (await handleEmoji(req("/frames"), new URL("http://x/api/emoji/frames"))).json();
check("frames decoded", frames.frames?.length === 4 && frames.width === 64);

const uni = await (await handleEmoji(req("/unicode"), new URL("http://x/api/emoji/unicode"))).json();
check("unicode round-trip verified", uni.verified === true, `${uni.chars} chars`);

const chat = await (await handleEmoji(
  req("/chat", { message: "hi! my name is tester" }),
  new URL("http://x/api/emoji/chat"),
)).json();
check("chat reply non-empty", typeof chat.reply === "string" && chat.reply.length > 0, JSON.stringify(chat.reply).slice(0, 60));
check("name memory learned", chat.transitions?.some((t: string) => t.includes("visitor.name")), chat.transitions?.join(" · "));
check("lifecycle greeted", chat.transitions?.some((t: string) => t.includes("lfc")));
check("chain grew with new hash", chat.chain?.length === 2 && chat.hash === chat.chain[1].hash);

const todo = await (await handleEmoji(
  req("/chat", { message: "remember to water the plants" }),
  new URL("http://x/api/emoji/chat"),
)).json();
const items = todo.emoji?.blocks?.find((b: { type: string }) => b.type === "tdo")?.items ?? [];
check("todo added via fnc/NLU", items.some((i: { value: string }) => i.value.toLowerCase().includes("water")), items.map((i: { value: string }) => i.value).join(", "));

const sw = await (await handleEmoji(req("/switch", { name: "nyx-owl" }), new URL("http://x/api/emoji/switch"))).json();
check("switch to nyx-owl", sw.emoji?.name === "nyx-owl" && sw.current === "nyx-owl");

if (failures) {
  console.error(`${failures} FAILURES`);
  Deno.exit(1);
}
console.log("ALL EMOJI HOST CHECKS PASSED");
