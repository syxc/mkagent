/** Independent login processes serialize grants and let a cancelled waiter leave without mutation. */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { FileAuthStorageBackend, McpOAuthCredentialStore } from '@mkagent/coding-runtime/mcp-oauth';
import { startOAuthMcpServer } from '../../../coding-runtime/test/fixtures/upstream/mcp-oauth-server.ts';

for (const secondAction of ['finish', 'cancel'] as const) {
  test(`a second login process can ${secondAction} while another process owns the interactive grant`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-process-login-'));
    const server = await startOAuthMcpServer();
    const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(root, 'mcp-auth.json')), root);
    const children: ReturnType<typeof launch>[] = [];
    function launch() {
      const child = spawn(process.execPath, [join(import.meta.dir, '../test-fixtures/mcp-login-process.ts'), root, server.url], {
        cwd: join(import.meta.dir, '../../../..'), stdio: ['pipe', 'pipe', 'pipe'],
      });
      const reader = createInterface({ input: child.stdout });
      const frames: Array<{ type: string; url?: string; text?: string; level?: string }> = [];
      let stderr = '';
      child.stderr.on('data', data => { stderr += String(data); });
      const exited = new Promise<number | null>(resolve => child.once('close', resolve));
      const listeners = new Set<() => void>();
      reader.on('line', line => { frames.push(JSON.parse(line)); for (const listener of [...listeners]) listener(); });
      const waitFor = (type: string) => new Promise<(typeof frames)[number]>((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Login process timed out: ${stderr}`)); }, 3000);
        const check = () => {
          const frame = frames.find(frame => frame.type === type);
          if (frame) { clearTimeout(timer); listeners.delete(check); resolve(frame); }
        };
        listeners.add(check); check();
      });
      return { child, reader, frames, exited, waitFor, stderr: () => stderr };
    }
    try {
      const first = launch(); children.push(first);
      const prompt = await first.waitFor('prompt');
      expect((await credentials.forServer('issues', server.url).load())?.tokens).toBeUndefined();
      const second = launch(); children.push(second);
      await second.waitFor('ready');
      await second.waitFor('lock-requested');
      if (secondAction === 'cancel') {
        second.child.stdin.write('cancel\n');
        expect(await second.exited).toBe(0);
        expect(second.frames.filter(frame => frame.type === 'notice'))
          .toEqual([{ type: 'notice', text: 'MCP operation cancelled.', level: 'info' }]);
        expect((await credentials.forServer('issues', server.url).load())?.tokens).toBeUndefined();
        expect(second.frames.some(frame => frame.type === 'lock-acquired')).toBe(false);
      } else {
        let completed = false;
        void second.exited.then(() => { completed = true; });
        await Bun.sleep(50);
        expect(completed).toBe(false);
      }
      expect(second.frames.some(frame => frame.type === 'prompt')).toBe(false);
      expect(server.authorizations).toEqual([]);
      expect(server.registrations).toHaveLength(1);
      expect(server.tokenRequests).toEqual([]);
      expect((await fetch(prompt.url!)).ok).toBe(true);
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      expect(first.frames.filter(frame => frame.type === 'notice'))
        .toEqual([{ type: 'notice', text: 'Signed in to MCP server "issues".', level: 'info' }]);
      if (secondAction === 'finish') expect(second.frames.filter(frame => frame.type === 'notice'))
        .toEqual([{ type: 'notice', text: 'Signed in to MCP server "issues".', level: 'info' }]);
      expect(second.frames.some(frame => frame.type === 'prompt')).toBe(false);
      expect(server.authorizations).toHaveLength(1);
      expect(server.tokenRequests.map(params => params.get('grant_type')))
        .toEqual(secondAction === 'finish' ? ['authorization_code', 'refresh_token'] : ['authorization_code']);
      expect((await credentials.forServer('issues', server.url).load())?.tokens?.refresh_token)
        .toBe(secondAction === 'finish' ? 'refresh-2' : 'refresh-1');
      expect(first.stderr()).toBe('');
      expect(second.stderr()).toBe('');
    } finally {
      for (const child of children) { child.child.kill(); child.reader.close(); }
      await Promise.all(children.map(child => child.exited));
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
}
