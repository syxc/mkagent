import { afterEach, expect, test } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { PrerequisiteManager } from '../core/prerequisite-manager.ts';

const agents: PiAgent[] = [];
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });
const guide = '/tmp/prerequisite-fixture/SKILL.md';

function fixture() {
  const agent = new PiAgent({
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'read-proof', name: 'Read proof', slug: 'read-proof', rootPath: '/tmp/prerequisite-fixture', createdAt: 1 },
    session: { id: `read-proof-${agents.length}`, workspaceRootPath: '/tmp/prerequisite-fixture', createdAt: 1, lastUsedAt: 1 },
  });
  agents.push(agent);
  agent.setPermissionMode('allow-all');
  const internals = agent as unknown as {
    prerequisiteManager: PrerequisiteManager;
    handlePreToolUseRequest(input: Record<string, unknown>): Promise<void>;
    handleSubprocessEvent(event: Record<string, unknown>): void;
    workerLease: unknown;
    send(message: unknown): void;
  };
  const manager = new PrerequisiteManager({ workspaceRootPath: '/tmp/prerequisite-fixture',
    browserToolEnabled: () => true, browserToolsDocPath: guide, pathExists: () => true });
  internals.prerequisiteManager = manager;
  internals.send = () => {};
  const approve = (id: string, toolName: string, input: Record<string, unknown>) =>
    internals.handlePreToolUseRequest({ requestId: `approval-${id}`, toolCallId: id, toolName, input });
  const start = (id: string, toolName: string, args: Record<string, unknown>) =>
    internals.handleSubprocessEvent({ type: 'tool_execution_start', toolCallId: id, toolName, args });
  const end = (id: string, toolName = 'read', isError = false, result: unknown = { content: [{ type: 'text', text: 'fixture instructions' }] }) =>
    internals.handleSubprocessEvent({ type: 'tool_execution_end', toolCallId: id, toolName, result, isError });
  return { agent, internals, manager, approve, start, end };
}

test('records Read only after its approved call succeeds, even when completions arrive out of order', async () => {
  const f = fixture();
  f.start('failed', 'read', { path: guide });
  expect(f.manager.hasRead(guide)).toBe(false);
  await f.approve('failed', 'Read', { file_path: guide });
  await f.approve('success', 'Read', { file_path: guide + '.other' });
  expect(f.manager.hasRead(guide + '.other')).toBe(false);
  f.end('success');
  f.end('failed', 'read', true);
  expect(f.manager.hasRead(guide)).toBe(false);
  expect(f.manager.hasRead(guide + '.other')).toBe(true);
  expect(f.manager.checkPrerequisites('browser_tool').allowed).toBe(false);
  await f.approve('ok', 'Read', { path: guide });
  f.end('ok');
  expect(f.manager.checkPrerequisites('browser_tool').allowed).toBe(true);
});

test('does not clear skill prerequisites during Bash precheck or after denied approval', async () => {
  const f = fixture();
  f.manager.registerSkillPrerequisites([guide]);
  f.agent.setPermissionMode('ask');
  f.agent.onPermissionRequest = request => f.agent.respondToPermission(request.requestId, false);
  await f.approve('denied', 'Bash', { command: `cat ${guide}; touch /tmp/prerequisite-fixture/denied` });
  f.end('denied', 'bash', true);
  expect(f.manager.hasRead(guide)).toBe(false);
  expect(f.manager.checkPrerequisites('Write').allowed).toBe(false);
  expect(f.manager.checkPrerequisites('Write').allowed).toBe(true);
  expect(f.manager.hasRead(guide)).toBe(false);
});

test('confirms only simple foreground shell reads and does not trust UI Read classification', async () => {
  const f = fixture();
  for (const [index, command] of [`cat ${guide} || true`, `false && cat ${guide}`,
    `cat ${guide} | head`, `cat --help ${guide}`, `sed -n q ${guide}`].entries()) {
    f.start(`complex-${index}`, 'bash', { command });
    await f.approve(`complex-${index}`, 'Bash', { command });
    f.end(`complex-${index}`, 'bash');
    expect(f.manager.hasRead(guide)).toBe(false);
  }
  await f.approve('background', 'Bash', { command: `cat ${guide}`, run_in_background: true });
  f.end('background', 'bash');
  expect(f.manager.hasRead(guide)).toBe(false);
  await f.approve('simple', 'Bash', { command: `head -n 20 ${guide}` });
  expect(f.manager.hasRead(guide)).toBe(false);
  f.end('simple', 'bash');
  expect(f.manager.hasRead(guide)).toBe(true);
});

test('rejects missing results, wrong names, errors and late completion after reset, abort or worker replacement', async () => {
  for (const action of ['missing', 'wrong-name', 'exit-code', 'reset', 'abort', 'worker'] as const) {
    const f = fixture();
    await f.approve('call', 'Read', { file_path: guide });
    if (action === 'reset') f.agent.resetPrerequisiteState();
    if (action === 'abort') await f.agent.abort();
    if (action === 'worker') f.internals.workerLease = {};
    f.end('call', action === 'wrong-name' ? 'bash' : 'read', false, action === 'missing' ? {} :
      { content: [{ type: 'text', text: 'output' }], ...(action === 'exit-code' ? { structuredContent: { exitCode: 1 } } : {}) });
    if (action === 'worker') f.internals.workerLease = null;
    expect(f.manager.hasRead(guide)).toBe(false);
    f.end('call');
    expect(f.manager.hasRead(guide)).toBe(false);
  }
});

test('a reset during Ask approval invalidates the pending read and later calls can still succeed', async () => {
  const f = fixture();
  f.agent.setPermissionMode('ask');
  const asked = Promise.withResolvers<string>();
  f.agent.onPermissionRequest = request => asked.resolve(request.requestId);
  const waiting = f.approve('old', 'Bash', { command: `cat ${guide}; touch /tmp/prerequisite-fixture/file` });
  const id = await asked.promise;
  f.agent.resetPrerequisiteState();
  f.agent.respondToPermission(id, true);
  await waiting;
  f.end('old', 'bash');
  expect(f.manager.hasRead(guide)).toBe(false);
  f.agent.setPermissionMode('allow-all');
  await f.approve('new', 'Read', { path: guide });
  f.end('new');
  expect(f.manager.hasRead(guide)).toBe(true);
});
