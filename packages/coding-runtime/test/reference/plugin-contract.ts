/** Execute unchanged upstream plugins and the shared session fixture in isolated native Pi. */
import { createReferenceRunner } from './harness.ts';

const [referenceNodeModules, upstreamRoot] = process.argv.slice(2);
if (!referenceNodeModules || !upstreamRoot) throw new Error('Supply isolated reference node_modules and pinned checkout');
const native = await createReferenceRunner({ referenceNodeModules, upstreamRoot, timeoutMs: 20_000 });
const trace = await native({ version: 1, id: 'native-plugin-contract', prompt: '', tools: [], replies: [] });
if (trace.pendingReplies !== 0 || trace.consumedReplies !== 4 || trace.final.isStreaming) {
  throw new Error(`Native plugin reply/idle mismatch: ${JSON.stringify({
    requests: trace.consumedReplies, pending: trace.pendingReplies, streaming: trace.final.isStreaming,
  })}`);
}
console.log(`PASS native-plugin-contract: ${trace.timeline.length} UI effects, 4 local replies, idle`);
