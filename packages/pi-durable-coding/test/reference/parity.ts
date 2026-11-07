/** Explicit, isolated native-versus-durable acceptance suite. */
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createReferenceRunner, createWorkerRunner } from './harness.ts';
import { scenarios } from './scenarios.ts';
import { assertTraceParity } from './trace.ts';

const [referenceNodeModules, upstreamRoot, selected] = process.argv.slice(2);
if (!referenceNodeModules || !upstreamRoot) throw new Error('Supply isolated reference node_modules and pinned source checkout');
const native = await createReferenceRunner({ referenceNodeModules, upstreamRoot, timeoutMs: 15_000 });
const durable = createWorkerRunner({
  script: fileURLToPath(new URL('./durable-worker.mjs', import.meta.url)), timeoutMs: 15_000,
}, { referenceNodeModules, provenance: native.provenance });
for (const scenario of scenarios) {
  if (selected && scenario.id !== selected) continue;
  const expected = await native(scenario);
  const actual = await durable(scenario);
  try {
    assertTraceParity(expected, actual);
  } catch (error) {
    writeFileSync(`/tmp/pi-parity-${scenario.id}.json`, JSON.stringify({ expected, actual }, null, 2));
    throw error;
  }
  console.log(`PASS ${scenario.id}`);
}
