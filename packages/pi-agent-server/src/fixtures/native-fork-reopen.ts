/** Isolated cold-process probe; all models and paths are supplied by the test. */
import { rmSync } from 'node:fs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension } from '@earendil-works/pi-durable';
import type { NativeSessionJournal } from '@mkagent/coding-runtime/durable';
import { durableFixture } from '../../../pi-durable-coding/test/fixtures/durable-harness.ts';
import { DurableKernel } from '../kernel.ts';

const [sessionPath, cwd, agentDir, mode] = process.argv.slice(2);
if (!sessionPath || !cwd || !agentDir) throw new Error('Missing isolated fixture paths');
const fixture = await durableFixture([]);
await fixture.harness.close(BACKGROUND_CONTEXT);
const kernel = new DurableKernel({
  sessionPath, cwd, modelsSource: () => fixture.models,
  toolsExtension: defineExtension({ name: 'empty' }),
  coding: { agentDir, projectTrusted: true, resourcePolicy: 'host-only' },
  wrapCodingTool: tool => tool,
  hooks: { emitEvent: () => {}, sessionToolCompleted: () => {}, prefetchToolCall: () => {},
    isPrefetchableTool: () => false, debugLog: () => {} },
});
try {
  await kernel.open({ model: { provider: 'faux', modelId: 'local', contextWindow: 100_000 } });
  const { journal } = (kernel as unknown as { coding: { journal: NativeSessionJournal } }).coding;
  console.log(JSON.stringify({ id: kernel.sessionId, snapshot: journal.committedSnapshot(), calls: fixture.calls.length }));
  if (mode === 'hold') await Bun.stdin.text();
} finally {
  await kernel.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}
