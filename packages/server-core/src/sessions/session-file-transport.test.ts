import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const managerUrl = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href

function probe(mode: 'branch' | 'import' | 'legacy-import' | 'fail-copy' | 'fail-import') {
  const root = mkdtempSync(join(tmpdir(), 'mkagent-file-transport-'))
  try {
    const script = `
      import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { SessionManager, savePiTurnAnchor } from ${JSON.stringify(managerUrl)};
      import { createSession, getSessionPath, loadSession, saveSession, serializeSession } from '@mkagent/shared/sessions';
      const root = process.env.CONFIG_DIR;
      const workspace = join(root, 'workspaces', 'fixture');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'config.json'), JSON.stringify({
        id: 'fixture', name: 'Fixture', slug: 'fixture', defaults: {}, createdAt: 1, updatedAt: 1,
      }));
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        workspaces: [{ id: 'fixture', name: 'Fixture', slug: 'fixture', rootPath: workspace, createdAt: 1 }],
        activeWorkspaceId: 'fixture', llmConnections: [],
      }));
      const source = loadSession(workspace, (await createSession(workspace, { name: 'Parent' })).id);
      const sourcePath = getSessionPath(workspace, source.id);
      source.sdkSessionId = 'fixture-sdk';
      mkdirSync(join(sourcePath, 'long_responses'), { recursive: true });
      const paths = ['attachments/document.txt', 'attachments/thumb.png', 'attachments/document.md', 'long_responses/result.txt'];
      for (const path of paths) writeFileSync(join(sourcePath, path), path);
      if (${JSON.stringify(mode)} === 'fail-copy') {
        rmSync(join(sourcePath, paths[1]));
        symlinkSync(join(sourcePath, paths[0]), join(sourcePath, paths[1]));
      }
      source.messages = [
        { id: 'user', role: 'user', timestamp: 1, content: 'file ' + join(sourcePath, paths[0]) +
          ' external ' + sourcePath + '-elsewhere/unrelated.txt', attachments: [{
          id: 'file', name: 'document.txt', type: 'text', mimeType: 'text/plain', size: 1,
          storedPath: join(sourcePath, paths[0]), thumbnailPath: join(sourcePath, paths[1]), markdownPath: join(sourcePath, paths[2]),
        }] },
        { id: 'answer', role: 'assistant', timestamp: 2, content: 'result [' + paths[3] + '](' + join(sourcePath, paths[3]) + ')' },
        { id: 'later', role: 'user', timestamp: 3, content: 'later-only' },
      ];
      writeFileSync(join(sourcePath, 'attachments', 'later-only.txt'), 'later-only');
      await saveSession(source);
      await savePiTurnAnchor(sourcePath, 'answer', 'fixture-anchor');
      const manager = new SessionManager();
      await manager.initialize();
      manager.getOrCreateAgent = async managed => {
        managed.agent = { ensureBranchReady: async () => {}, destroy() {} };
        return managed.agent;
      };
      const before = readdirSync(join(workspace, 'sessions')).sort();
      let imported;
      let error = '';
      try {
        const mode = ${JSON.stringify(mode)};
        const bundle = serializeSession(workspace, source.id);
        if (mode === 'legacy-import') {
          bundle.session.messages = source.messages;
          bundle.session.header.workspaceRootPath = '~/foreign-machine/workspace';
        }
        if (mode === 'fail-import') bundle.files.push({
          relativePath: '../escape.txt', contentBase64: '', size: 0,
        });
        imported = mode.includes('import')
          ? await manager.importSession('fixture', bundle, 'fork')
          : await manager.createSession('fixture', { branchFromSessionId: source.id, branchFromMessageId: 'answer' });
      } catch (failure) { error = failure.message; }
      const after = readdirSync(join(workspace, 'sessions')).sort();
      let details;
      if (imported) {
        const id = imported.sessionId ?? imported.id;
        const target = getSessionPath(workspace, id);
        const stored = loadSession(workspace, id);
        const originalIntact = paths.every(path => readFileSync(join(sourcePath, path), 'utf8') === path);
        if (${JSON.stringify(mode)}.includes('import')) rmSync(sourcePath, { recursive: true });
        const attachment = stored.messages[0].attachments[0];
        details = {
          target, content: stored.messages[0].content, result: stored.messages[1].content,
          attachment, originalIntact,
          files: [attachment.storedPath, attachment.thumbnailPath, attachment.markdownPath, join(target, paths[3])]
            .map(path => existsSync(path) ? readFileSync(path, 'utf8') : null),
          laterFile: existsSync(join(target, 'attachments', 'later-only.txt')),
        };
      }
      manager.cleanup();
      console.log(JSON.stringify({ error, before, after, details, sourcePath }));
    `
    const child = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: join(import.meta.dir, '..', '..'),
      env: { ...process.env, CONFIG_DIR: root }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return JSON.parse(child.stdout.toString())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('session file transport', () => {
  for (const mode of ['branch', 'import', 'legacy-import'] as const) it(`retains independent attachment files and precise references on ${mode}`, () => {
    const { error, details, sourcePath } = probe(mode)
    expect(error).toBe('')
    expect(details.originalIntact).toBe(true)
    expect(details.files).toEqual(['attachments/document.txt', 'attachments/thumb.png', 'attachments/document.md', 'long_responses/result.txt'])
    expect(details.attachment.storedPath).toBe(join(details.target, 'attachments', 'document.txt'))
    expect(details.content).toContain(sourcePath + '-elsewhere/unrelated.txt')
    expect(details.content).toContain(join(details.target, 'attachments', 'document.txt'))
    expect(details.result).toContain(join(details.target, 'long_responses', 'result.txt'))
    if (mode === 'branch') expect(details.laterFile).toBe(false)
  })

  it('rejects a linked attachment and removes the partial branch', () => {
    const { error, before, after } = probe('fail-copy')
    expect(error).toContain('symbolic link')
    expect(after).toEqual(before)
  })

  it('removes a partial import when a bundled file fails validation', () => {
    const { error, before, after } = probe('fail-import')
    expect(error).toContain('Invalid bundle file')
    expect(after).toEqual(before)
  })
})
