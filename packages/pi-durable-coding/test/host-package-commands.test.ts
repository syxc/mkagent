import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPackageSession } from './fixtures/host-package-runner.ts';

let root: string;
let cwd: string;
let agentDir: string;
let npm: string;
let log: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'host-package-commands-')));
  cwd = join(root, 'project');
  agentDir = join(root, 'agent');
  npm = join(root, 'fake-npm.ts');
  log = join(root, 'commands.jsonl');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(root, 'version'), '1.0.0');
  writeFileSync(npm, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(process.argv.indexOf('npm') + 1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  console.log(JSON.stringify({ version: readFileSync(join(root, 'version'), 'utf8') }));
  process.exit(0);
}
process.stdout.write('PACKAGE_SUBPROCESS_STDOUT\\n');
if (existsSync(join(root, 'fail'))) process.exit(17);
if (existsSync(join(root, 'batch-fail')) && args.includes('--prefix')) {
  await fetch(readFileSync(join(root, 'batch-fail'), 'utf8') + '/fail');
  process.exit(17);
}
if (existsSync(join(root, 'block'))) {
  const endpoint = readFileSync(join(root, 'block'), 'utf8');
  await fetch(endpoint + '/started');
  await fetch(endpoint + '/release');
}
if (!args.includes('--prefix')) process.exit(0);
const prefix = args[args.indexOf('--prefix') + 1];
for (const spec of args.slice(1, args.indexOf('--prefix'))) {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const directory = join(prefix, 'node_modules', name);
  if (args[0] === 'uninstall') rmSync(directory, { recursive: true, force: true });
  else {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name, version: readFileSync(join(root, 'version'), 'utf8'), pi: { prompts: ['package.md'] }
    }));
    writeFileSync(join(directory, 'package.md'), 'Package prompt ' + name);
  }
}
if (existsSync(join(root, 'fail-settings'))) {
  renameSync(join(root, 'agent', 'settings.json'), join(root, 'settings-before-failure.json'));
  mkdirSync(join(root, 'agent', 'settings.json'));
}
`);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    npmCommand: [process.execPath, npm, '--', 'npm'], cacheWarming: 'off',
  }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const commands = (): string[][] => existsSync(log)
  ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const settings = (directory: string) => JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));

test('native install persists and reloads a package, update stays in its selected scope and remove unloads it', async () => {
  const runtime = await openPackageSession(root);
  try {
    await runtime.session.prompt('/packages install npm:fixture-pkg');
    expect(settings(agentDir).packages).toEqual(['npm:fixture-pkg']);
    expect(runtime.resourceLoader.getPrompts().prompts.map(prompt => prompt.name)).toContain('package');
    expect(commands().at(-1)).toContain(join(agentDir, 'npm'));
    await runtime.session.prompt('/packages install --local npm:fixture-pkg');
    expect(settings(join(cwd, '.pi')).packages).toEqual(['npm:fixture-pkg']);
    const start = commands().length;
    writeFileSync(join(root, 'version'), '2.0.0');
    await runtime.session.prompt('/packages update');
    const updated = commands().slice(start).filter(args => args[0] === 'install');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toContain(join(agentDir, 'npm'));
    expect(JSON.parse(readFileSync(join(cwd, '.pi', 'npm', 'node_modules', 'fixture-pkg', 'package.json'), 'utf8')).version).toBe('1.0.0');
    await runtime.session.prompt('/packages update --local');
    expect(JSON.parse(readFileSync(join(cwd, '.pi', 'npm', 'node_modules', 'fixture-pkg', 'package.json'), 'utf8')).version).toBe('2.0.0');
    await runtime.session.prompt('/packages remove npm:fixture-pkg');
    expect(settings(agentDir).packages).toEqual([]);
    expect(settings(join(cwd, '.pi')).packages).toEqual(['npm:fixture-pkg']);
    await runtime.session.prompt('/packages remove --local npm:fixture-pkg');
    expect(runtime.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(runtime.notifications.filter(entry => entry.type === 'error')).toEqual([]);
    expect(runtime.errors).toEqual([]);
  } finally { await runtime.close(); }
});

test('untrusted projects cannot install or update, while user operations remain available', async () => {
  const runtime = await openPackageSession(root, false);
  try {
    await runtime.session.prompt('/packages install --local npm:fixture-pkg');
    await runtime.session.prompt('/packages update --local');
    expect(commands()).toEqual([]);
    expect(existsSync(join(cwd, '.pi'))).toBe(false);
    expect(runtime.notifications.filter(entry => entry.type === 'error').map(entry => entry.message))
      .toEqual(['Project is not trusted; reload and approve project trust first',
        'Project is not trusted; reload and approve project trust first']);
    await runtime.session.prompt('/packages install npm:fixture-pkg');
    expect(settings(agentDir).packages).toEqual(['npm:fixture-pkg']);
    expect(commands()).toHaveLength(1);
  } finally { await runtime.close(); }
});

test('failed installation does not persist a source or trigger resource reload', async () => {
  writeFileSync(join(root, 'fail'), '');
  const runtime = await openPackageSession(root);
  try {
    const before = runtime.session.extensionRunner;
    await runtime.session.prompt('/packages install npm:fixture-pkg');
    expect(settings(agentDir).packages).toBeUndefined();
    expect(runtime.session.extensionRunner).toBe(before);
    expect(runtime.notifications.at(-1)).toMatchObject({ type: 'error' });
    expect(runtime.notifications.at(-1)?.message).toContain('code 17');
  } finally { await runtime.close(); }
});

test('package subprocess stdout stays off the JSON protocol stream', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'host-package-runner.ts'), root], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toContain('PACKAGE_SUBPROCESS_STDOUT');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  const result = JSON.parse(stdout);
  expect(result.errors).toEqual([]);
  expect(result.notifications.filter((entry: { type: string }) => entry.type === 'error')).toEqual([]);
});

test('settings write failure keeps the loaded catalog and a manual retry persists after storage recovers', async () => {
  writeFileSync(join(root, 'fail-settings'), '');
  const runtime = await openPackageSession(root);
  try {
    const before = runtime.session.extensionRunner;
    await runtime.session.prompt('/packages install npm:fixture-pkg');
    expect(commands()).toHaveLength(1);
    expect(existsSync(join(agentDir, 'npm', 'node_modules', 'fixture-pkg', 'package.json'))).toBe(true);
    expect(runtime.session.extensionRunner).toBe(before);
    expect(runtime.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(runtime.notifications.at(-1)).toMatchObject({ type: 'error' });
    expect(runtime.notifications.at(-1)?.message).toContain('Package files may have changed');
    rmSync(join(agentDir, 'settings.json'), { recursive: true });
    renameSync(join(root, 'settings-before-failure.json'), join(agentDir, 'settings.json'));
    rmSync(join(root, 'fail-settings'));
    await runtime.session.prompt('/packages install npm:fixture-pkg');
    expect(settings(agentDir).packages).toEqual(['npm:fixture-pkg']);
    expect(runtime.resourceLoader.getPrompts().prompts.map(prompt => prompt.name)).toContain('package');
  } finally { await runtime.close(); }
});

test('shutdown drains an accepted installer and prevents reload or another installation', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/started') started.resolve();
    if (path === '/release') await release.promise;
    return new Response('ok');
  } });
  writeFileSync(join(root, 'block'), `http://127.0.0.1:${server.port}`);
  const runtime = await openPackageSession(root);
  let closing: Promise<void> | undefined;
  const installation = runtime.session.prompt('/packages install npm:fixture-pkg');
  try {
    await started.promise;
    let closed = false;
    closing = runtime.close().then(() => { closed = true; });
    await fetch(`http://127.0.0.1:${server.port}/heartbeat`);
    expect(closed).toBe(false);
    await runtime.session.prompt('/packages install npm:another-pkg');
    release.resolve();
    await Promise.all([installation, closing]);
    expect(closed).toBe(true);
    expect(commands()).toHaveLength(1);
    expect(settings(agentDir).packages).toEqual(['npm:fixture-pkg']);
    expect(runtime.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(runtime.errors).toEqual([]);
  } finally {
    release.resolve();
    await installation;
    if (closing) await closing; else await runtime.close();
    server.stop(true);
  }
});

function useFakeGit() {
  const bin = join(root, 'bin');
  const gitLog = join(root, 'git.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'clone') throw new Error('Unexpected git command: ' + args[0]);
if (existsSync(join(root, 'batch'))) {
  const endpoint = readFileSync(join(root, 'batch'), 'utf8');
  if (args[1].endsWith('/failing.git')) {
    await fetch(endpoint + '/fail');
    process.exit(17);
  }
  await fetch(endpoint + '/blocked');
  await fetch(endpoint + '/release');
}
const directory = args.at(-1);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'package.json'), '{"name":"git-fixture","pi":{"prompts":["git.md"]}}');
writeFileSync(join(directory, 'git.md'), 'Git package prompt');
process.stdout.write('GIT_SUBPROCESS_STDOUT\\n');
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  return { gitLog, [Symbol.dispose]() {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  } };
}

test('git packages use the native clone and dependency installer and remove only their managed checkout', async () => {
  using git = useFakeGit();
  const runtime = await openPackageSession(root);
  try {
    const source = 'git:https://invalid.example/owner/fixture.git';
    await runtime.session.prompt(`/packages install ${source}`);
    expect(runtime.notifications.filter(entry => entry.type === 'error')).toEqual([]);
    const gitCommands: string[][] = readFileSync(git.gitLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(gitCommands).toHaveLength(1);
    expect(gitCommands[0]?.[0]).toBe('clone');
    const checkout = gitCommands[0]!.at(-1)!;
    expect(checkout.startsWith(join(agentDir, 'git'))).toBe(true);
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toContain('--omit=dev');
    expect(runtime.resourceLoader.getPrompts().prompts.map(prompt => prompt.name)).toContain('git');
    await runtime.session.prompt(`/packages remove ${source}`);
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(cwd)).toBe(true);
    expect(runtime.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(runtime.notifications.filter(entry => entry.type === 'error')).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test('two native owners keep saved package sources and list reads the latest configuration', async () => {
  const first = await openPackageSession(root);
  const second = await openPackageSession(root);
  const sources = ['alpha', 'beta'].map(name => {
    const directory = join(root, name);
    mkdirSync(directory);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, pi: { prompts: [`${name}.md`] } }));
    writeFileSync(join(directory, `${name}.md`), `Package ${name}`);
    return directory;
  });
  try {
    await first.session.prompt(`/packages install "${sources[0]}"`);
    await second.session.prompt('/packages list');
    const listing = second.notifications.at(-1)?.message;
    await second.session.prompt(`/packages install "${sources[1]}"`);
    expect(settings(agentDir).packages).toHaveLength(2);
    expect(listing).toContain('alpha');
    expect(second.resourceLoader.getPrompts().prompts.map(prompt => prompt.name).sort()).toEqual(['alpha', 'beta']);
  } finally { await Promise.all([first.close(), second.close()]); }
});

for (const failure of ['git', 'npm'] as const) {
  test(`partially failing ${failure} update and shutdown wait for the other git installer`, async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failedExit = Promise.withResolvers<void>();
    const dependencyExit = Promise.withResolvers<void>();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/blocked') blocked.resolve();
      if (path === '/fail') await blocked.promise;
      if (path === '/release') await release.promise;
      return new Response('ok');
    } });
    const endpoint = `http://127.0.0.1:${server.port}`;
    writeFileSync(join(root, 'batch'), endpoint);
    if (failure === 'npm') writeFileSync(join(root, 'batch-fail'), endpoint);
    using git = useFakeGit();
    using cleanup = new DisposableStack();
    const original = childProcess.spawn;
    const spawn = spyOn(childProcess, 'spawn').mockImplementation((...parameters: Parameters<typeof childProcess.spawn>) => {
      const child = original(...parameters);
      const [command, args, options] = parameters;
      if (Array.isArray(args)) {
        if ((command === 'git' && args.some(arg => arg.endsWith('/failing.git')))
          || (command === process.execPath && args.includes('--prefix') && failure === 'npm')) {
          child.once('exit', () => failedExit.resolve());
        }
        if (command === process.execPath && options?.cwd?.toString().includes('blocked')) {
          child.once('exit', () => dependencyExit.resolve());
        }
      }
      return child;
    });
    cleanup.defer(() => spawn.mockRestore());
    const config = settings(agentDir);
    config.packages = [failure === 'git' ? 'git:https://invalid.example/owner/failing.git' : 'npm:fixture-pkg',
      'git:https://invalid.example/owner/blocked.git'];
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(config));
    const runtime = await openPackageSession(root);
    let returned = false;
    let closed = false;
    const updating = runtime.session.prompt('/packages update').then(() => { returned = true; });
    let closing: Promise<void> | undefined;
    try {
      await failedExit.promise;
      await fetch(`${endpoint}/heartbeat`);
      closing = runtime.close().then(() => { closed = true; });
      await fetch(`${endpoint}/heartbeat`);
      const beforeRelease = { returned, closed };
      release.resolve();
      await Promise.all([updating, closing, dependencyExit.promise]);
      expect(beforeRelease).toEqual({ returned: false, closed: false });
      expect(runtime.notifications.some(entry => entry.type === 'error' && entry.message.includes('code 17'))).toBe(false);
    } finally {
      release.resolve();
      await updating;
      if (closing) await closing; else await runtime.close();
      await dependencyExit.promise;
      server.stop(true);
    }
  });
}
