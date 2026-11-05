/** Retiring a native worker owner closes pending OAuth callbacks and rejects late UI replies. */
import { expect, test } from 'bun:test';
import { startOAuthMcpServer } from '../../../pi-durable-coding/test/fixtures/upstream/mcp-oauth-server.ts';
import { withOAuthWorker } from '../test-fixtures/mcp-oauth-worker.ts';

for (const retirement of ['reinit', 'release', 'shutdown'] as const) {
  test(`worker ${retirement} cancels a native login without accepting a late callback`, async () => {
    const server = await startOAuthMcpServer();
    try {
      await withOAuthWorker(server.url, async worker => {
        const source = { ownerSessionId: 'source', runtimeGeneration: 1 };
        worker.init('source', 1);
        await worker.waitFor(frame => frame.type === 'ready' && frame.runtimeGeneration === 1);
        worker.send({ type: 'prompt', id: 'login', message: '/mcp login issues', systemPrompt: '', ...source });
        const request = await worker.waitFor(frame => frame.type === 'extension_ui_request' && frame.method === 'input');
        const widget = await worker.waitFor(frame =>
          frame.type === 'extension_ui_request' && frame.method === 'setWidget' && frame.widgetKey === 'mcp-login-issues'
          && frame.widgetLines?.length === 2);
        expect(request.title).toBe('MCP sign-in: issues');
        expect(server.registrations).toHaveLength(1);
        expect(server.authorizations).toEqual([]);
        expect((await worker.credentials.forServer('issues', server.url).load())?.tokens).toBeUndefined();
        const target = { ownerSessionId: 'target', runtimeGeneration: 2 };
        if (retirement === 'reinit') {
          worker.init('target', 2);
          await worker.waitFor(frame => frame.type === 'ready' && frame.runtimeGeneration === 2);
        } else if (retirement === 'release') {
          worker.send({ type: 'release_owner', id: 'release', ...source });
          expect(await worker.waitFor(frame => frame.id === 'release')).toMatchObject({ released: true, ...source });
        } else {
          worker.send({ type: 'shutdown', ...source });
          expect(await worker.exited).toBe(0);
        }
        const redirect = (await fetch(widget.widgetLines![1]!, { redirect: 'manual' })).headers.get('location')!;
        // Bun distinguishes a refused connection from HTTP errors and request timeouts.
        await expect(fetch(redirect, { signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: 'ConnectionRefused' });
        expect(server.tokenRequests).toEqual([]);
        expect((await worker.credentials.forServer('issues', server.url).load())?.tokens).toBeUndefined();
        if (retirement === 'release') {
          worker.init('target', 2);
          await worker.waitFor(frame => frame.type === 'ready' && frame.runtimeGeneration === 2);
        }
        if (retirement !== 'shutdown') {
          worker.send({ type: 'extension_ui_response', responseId: 'late', id: request.id,
            uiEpoch: request.uiEpoch, value: redirect, ...target });
          expect(await worker.waitFor(frame => frame.id === 'late')).toMatchObject({ accepted: false, ...target });
          worker.send({ type: 'prompt', id: 'status', message: '/mcp status', systemPrompt: '', ...target });
          const status = await worker.waitFor(frame => frame.ownerSessionId === 'target'
            && frame.type === 'extension_ui_request' && frame.method === 'setWidget' && frame.widgetKey === 'mcp-status');
          expect(status.widgetLines?.join('\n')).toContain('issues: needs-auth');
        }
        expect(server.authorizations).toHaveLength(1);
        expect(worker.modelRequests()).toBe(0);
      });
    } finally { await server.close(); }
  }, 15_000);
}
