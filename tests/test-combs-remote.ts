// Live verification for atoms/backends/combs-remote.js against combs serve.
// deno run --location=http://localhost --allow-net --allow-env test-combs-remote.ts
import { CombsRemoteBackend, setCombsEngineUrl } from '../atoms/backends/combs-remote.js';

setCombsEngineUrl('http://127.0.0.1:8475');

const backend = new CombsRemoteBackend();
await backend.mount(null, null, {});
console.log('mounted, session:', backend.sessionId);

const longDoc = 'The combs mesh protocol uses content-addressed emojis. '.repeat(40);
const history = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: `Read this: ${longDoc}\nIn one word, what does the protocol use?` },
];
const t1 = await backend.send(null, { history }, () => {});
console.log('turn1 reply:', JSON.stringify(t1.slice(0, 60)));
console.log('turn1 usage:', backend.lastUsage);

history.push({ role: 'assistant', content: t1 });
history.push({ role: 'user', content: 'And what is it addressed by?' });
const t2 = await backend.send(null, { history }, () => {});
console.log('turn2 reply:', JSON.stringify(t2.slice(0, 60)));
console.log('turn2 usage:', backend.lastUsage);

if (!backend.lastUsage || backend.lastUsage.cachedTokens <= 0) {
  console.error('FAIL: expected cached_tokens > 0 on turn 2');
  Deno.exit(1);
}
console.log('PASS: rolling-session KV reuse verified from the browser backend contract');
