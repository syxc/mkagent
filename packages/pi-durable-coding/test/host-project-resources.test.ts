import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareHostResources } from '../src/host-project-resources.ts';
import { ProjectTrustStore } from '../src/pi/core/trust-manager.ts';
import type { ProjectTrustContext } from '../src/pi/core/extensions/types.ts';

let root: string;
let cwd: string;
let agentDir: string;
const errors: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-project-resources-'));
  cwd = join(root, 'project');
  agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  errors.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function context(select: ProjectTrustContext['ui']['select'], hasUI = true): ProjectTrustContext {
  return { cwd, mode: hasUI ? 'rpc' : 'print', hasUI,
    ui: { select, input: async () => undefined, confirm: async () => false, notify() {} } };
}
const options = () => ({ cwd, agentDir, globalSettings: { defaultProjectTrust: 'ask' as const } });
const failed = (message: string) => errors.push(message);

test('project code waits for the trust response, loads once and never installs missing packages', async () => {
  const marker = join(root, 'executed');
  const globalMarker = join(root, 'global-executed');
  put(join(cwd, '.pi', 'extensions', 'project.ts'),
    `import { appendFileSync } from 'node:fs'; export default function() { appendFileSync(${JSON.stringify(marker)}, 'loaded\\n'); }`);
  put(join(agentDir, 'extensions', 'global.ts'),
    `import { appendFileSync } from 'node:fs'; export default function() { appendFileSync(${JSON.stringify(globalMarker)}, 'loaded\\n'); }`);
  put(join(cwd, '.pi', 'settings.json'), JSON.stringify({
    defaultProjectTrust: 'always', packages: ['git:https://invalid.example/must-not-fetch'],
  }));
  const asked = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<string | undefined>();
  const resources = prepareHostResources(options(), () => context(async () => {
    asked.resolve();
    return decision.promise;
  }), failed);
  await asked.promise;
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(globalMarker, 'utf8')).toBe('loaded\n');
  decision.resolve('Trust (this session only)');
  const ready = await resources;
  expect(ready.settingsManager.isProjectTrusted()).toBe(true);
  expect(readFileSync(marker, 'utf8')).toBe('loaded\n');
  expect(readFileSync(globalMarker, 'utf8')).toBe('loaded\n');
  expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
  expect(errors).toEqual([]);
});

test('headless startup and cancelled prompts cannot take trust from project settings', async () => {
  const marker = join(root, 'executed');
  put(join(cwd, '.pi', 'extensions', 'project.ts'),
    `import { writeFileSync } from 'node:fs'; export default function() { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`);
  put(join(cwd, '.pi', 'settings.json'), '{"defaultProjectTrust":"always"}');
  let asked = 0;
  const noUI = await prepareHostResources(options(), () => context(async () => { asked++; return 'Trust'; }, false), failed);
  expect(noUI.settingsManager.isProjectTrusted()).toBe(false);
  expect(asked).toBe(0);
  const cancelled = await prepareHostResources(options(), () => context(async () => undefined), failed);
  expect(cancelled.settingsManager.isProjectTrusted()).toBe(false);
  expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
  expect(existsSync(marker)).toBe(false);
});

test('native reload rechecks new resources, retries cancellation and retains a session-only decision', async () => {
  let asked = 0;
  const getContext = () => context(async () => ++asked === 1 ? undefined : 'Trust (this session only)');
  const resources = await prepareHostResources(options(), getContext, failed);
  expect(asked).toBe(0);
  const marker = join(root, 'executed');
  put(join(cwd, '.pi', 'extensions', 'project.ts'),
    `import { writeFileSync } from 'node:fs'; export default function() { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`);
  await resources.resourceLoader.reload();
  expect(resources.settingsManager.isProjectTrusted()).toBe(false);
  expect(existsSync(marker)).toBe(false);
  await resources.resourceLoader.reload();
  expect(resources.settingsManager.isProjectTrusted()).toBe(true);
  expect(readFileSync(marker, 'utf8')).toBe('loaded');
  expect(asked).toBe(2);
  await resources.resourceLoader.reload();
  expect(resources.settingsManager.isProjectTrusted()).toBe(true);
  expect(asked).toBe(2);
});

test('a native global project_trust hook can remember its decision before project code loads', async () => {
  const marker = join(root, 'order');
  put(join(agentDir, 'extensions', 'trust.ts'), `
    import { appendFileSync } from 'node:fs';
    export default function(pi) {
      appendFileSync(${JSON.stringify(marker)}, 'global\\n');
      pi.on('project_trust', () => {
        appendFileSync(${JSON.stringify(marker)}, 'trust\\n');
        return { trusted: 'yes', remember: true };
      });
    }
  `);
  put(join(cwd, '.pi', 'extensions', 'project.ts'),
    `import { appendFileSync } from 'node:fs'; export default function() { appendFileSync(${JSON.stringify(marker)}, 'project\\n'); }`);
  const resources = await prepareHostResources(options(), () => context(async () => { throw new Error('unexpected prompt'); }), failed);
  expect(resources.settingsManager.isProjectTrusted()).toBe(true);
  expect(readFileSync(marker, 'utf8')).toBe('global\ntrust\nproject\n');
  expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(true);
  expect(errors).toEqual([]);
});

test('project MCP alone requires trust, and remembered rejection survives a new resource loader', async () => {
  put(join(cwd, '.mkagent', 'mcp.json'), '{"mcpServers":{}}');
  const resources = await prepareHostResources(options(), () => context(async title => {
    expect(title).toContain('MCP servers');
    return 'Do not trust';
  }), failed);
  expect(resources.settingsManager.isProjectTrusted()).toBe(false);
  expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(false);
  const reopened = await prepareHostResources(options(), () => context(async () => { throw new Error('unexpected prompt'); }), failed);
  expect(reopened.settingsManager.isProjectTrusted()).toBe(false);
});

test('host-only policy skips ambient trust and discovery while explicit trust stays authoritative', async () => {
  put(join(agentDir, 'extensions', 'must-not-load.ts'), 'throw new Error("ambient extension executed");');
  put(join(cwd, '.pi', 'settings.json'), '{"defaultProjectTrust":"always"}');
  const forbidden = () => { throw new Error('unexpected trust context'); };
  const resources = await prepareHostResources({ ...options(), resourcePolicy: 'host-only' }, forbidden, failed);
  expect(resources.resourceLoader.getExtensions().extensions).toEqual([]);
  expect(existsSync(join(agentDir, 'trust.json'))).toBe(false);
  const denied = await prepareHostResources({ ...options(), projectTrusted: false, noExtensions: true }, forbidden, failed);
  expect(denied.settingsManager.isProjectTrusted()).toBe(false);
});
