import { expect, test } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createEventBus, createExtensionRuntime, execCommand, ExtensionRunner, getReadmePath,
  loadExtensionFromFactory, ModelRegistry, ModelRuntime, SessionManager, theme,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

async function fixture(factory: ExtensionFactory = () => {}, dependencies?: ConstructorParameters<typeof ExtensionRunner>[5]) {
  const cwd = process.cwd();
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(factory, cwd, createEventBus(), runtime, 'fixture');
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  return new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(models), dependencies);
}

test('isolates live theme bindings and restores each runner UI without changing SDK defaults', async () => {
  let currentTheme = theme;
  const host = await fixture(undefined, { getTheme: () => currentTheme });
  const ordinary = await fixture();
  expect(host.hasUI()).toBe(false);
  expect(ordinary.hasUI()).toBe(false);
  expect(host.getUIContext().theme).toBe(theme);
  currentTheme = new Proxy(theme, {});
  expect(host.getUIContext().theme).toBe(currentTheme);
  expect(ordinary.getUIContext().theme).toBe(theme);
  host.setUIContext({ ...host.getUIContext(), theme });
  expect(host.hasUI()).toBe(true);
  expect(host.getUIContext().theme).toBe(theme);
  host.setUIContext();
  expect(host.hasUI()).toBe(false);
  expect(host.getUIContext().theme).toBe(currentTheme);
  expect(ordinary.hasUI()).toBe(false);
});

test('keeps prompt mutation, forced prompts and handler errors within the owning runner', async () => {
  const seen: string[] = [];
  const runner = await fixture(pi => {
    pi.on('before_agent_start', (event, context) => {
      seen.push(event.systemPrompt, context.getSystemPrompt());
      event.systemPromptOptions.sections.fixture = 'changed';
      expect(context.getSystemPrompt()).toBe('host:changed');
      return { systemPrompt: 'forced' };
    });
    pi.on('before_agent_start', (event, context) => {
      seen.push(event.systemPrompt, context.getSystemPrompt());
      throw new Error('fixture error');
    });
    pi.on('before_agent_start', event => { seen.push(event.systemPrompt); });
  }, { buildSystemPrompt: options => options.forceSystemPrompt ?? 'host:' + options.sections?.fixture });
  const errors: string[] = [];
  runner.onError(error => errors.push(error.error));
  const options = { cwd: process.cwd(), selectedTools: [], sections: { fixture: 'initial' } };
  const result = await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'fixture' }, options);
  expect(seen).toEqual(['host:initial', 'host:initial', 'forced', 'forced', 'forced']);
  expect(errors).toEqual(['fixture error']);
  expect(result?.systemPromptOptions.forceSystemPrompt).toBe('forced');
  expect(options.sections.fixture).toBe('initial');
  let ordinaryPrompt = '';
  const ordinary = await fixture(pi => { pi.on('before_agent_start', event => { ordinaryPrompt = event.systemPrompt; }); });
  await ordinary.emitBeforeAgentStart({ messageType: 'user', prompt: 'fixture' }, options);
  expect(ordinaryPrompt).toContain(getReadmePath());
  expect(ordinaryPrompt).not.toContain('host:');
  expect(ordinaryPrompt).not.toBe('forced');
});

test('uses the SDK command executor with UTF-8 output, output caps and cancellation', async () => {
  const cwd = process.cwd();
  const normal = await execCommand(process.execPath, ['-e', 'process.stdout.write("中文"); process.stderr.write("错误")'], cwd);
  expect(normal).toEqual({ stdout: '中文', stderr: '错误', code: 0, killed: false, truncated: false });
  const capped = await execCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], cwd, { maxBuffer: 12 });
  expect(capped.stdout).toBe('x'.repeat(12));
  expect(capped.truncated).toBe(true);
  expect(capped.code).not.toBe(0);
  const cancelled = await execCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], cwd,
    { signal: AbortSignal.abort() });
  expect(cancelled.killed).toBe(true);
  expect(cancelled.truncated).toBe(false);
});
