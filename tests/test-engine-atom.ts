// Live verification for atoms/engine/index.js against combs serve.
// Needs COMBSLLM_ENGINE (default http://127.0.0.1:8475) reachable.
// deno run --location=http://localhost --allow-net --allow-env tests/test-engine-atom.ts
import { streamChatWithUsage } from "../atoms/engine/index.js";

const ENGINE = Deno.env.get("COMBSLLM_ENGINE") || "http://127.0.0.1:8475";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
}

interface Turn { role: string; content: string }
function chat(messages: Turn[], sessionId?: string): Promise<{ text: string; usage: any }> {
  return new Promise((resolve, reject) => {
    let text = "";
    let usage = null;
    streamChatWithUsage(ENGINE, messages, { maxTokens: 24, sessionId }, {
      onDelta: (t: string) => { text += t; },
      onUsage: (u: any) => { usage = u; },
      onDone: () => resolve({ text, usage }),
      onError: reject,
    });
  });
}

const longDoc = "Prefix caching saves recomputation. ".repeat(50);

// 1. anonymous rolling session: turn 2 must hit the prefix cache
const t1 = await chat([
  { role: "user", content: `${longDoc}\nOne word: what does prefix caching save?` },
]);
check("turn1 completes", t1.text.length > 0);
check("turn1 usage present", !!t1.usage && t1.usage.prompt_tokens > 0, `prompt=${t1.usage?.prompt_tokens}`);

const t2 = await chat([
  { role: "user", content: `${longDoc}\nOne word: what does prefix caching save?` },
  { role: "assistant", content: t1.text },
  { role: "user", content: "And what does it reuse?" },
]);
const cached2 = t2.usage?.prompt_tokens_details?.cached_tokens ?? 0;
check("turn2 hits prefix cache (anonymous rolling session)", cached2 > 0, `cached=${cached2}/${t2.usage?.prompt_tokens}`);

// 2. debate invariant: interleaved NAMED sessions keep their own prefixes
const a1 = await chat([{ role: "user", content: `${longDoc}\nArgue FOR prefix caching in 5 words.` }], "agent-A");
const b1 = await chat([{ role: "user", content: `${longDoc}\nArgue AGAINST caching in 5 words.` }], "agent-B");
const a2 = await chat([
  { role: "user", content: `${longDoc}\nArgue FOR prefix caching in 5 words.` },
  { role: "assistant", content: a1.text },
  { role: "user", content: b1.text },
  { role: "user", content: "Rebut in 5 words." },
], "agent-A");
const cachedA2 = a2.usage?.prompt_tokens_details?.cached_tokens ?? 0;
check("named session agent-A reuses ITS prefix after B's interleave", cachedA2 > 0, `cached=${cachedA2}`);
check("sessions produced distinct voices", a1.text !== b1.text);

if (failures) { console.error(`${failures} FAILURES`); Deno.exit(1); }
console.log("ALL ENGINE-ATOM CHECKS PASSED");
