import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

for (const path of ['../src/upstream/core/extensions/loader.js', '../src/pi/core/extensions/loader.ts']) {
  test.each(['native', 'host', 'plugin'])(`extension dependencies preserve %s stack handling through ${path}`, mode => {
    const directory = mkdtempSync(join(tmpdir(), 'plugin-transpiler-'));
    directories.push(directory);
    // Populate the bootstrap cache without initializing Babel in the process that loads the plugin.
    const seed = Bun.spawnSync([process.execPath, '--eval', `
      const { createJiti } = await import(${JSON.stringify(import.meta.resolve('jiti/static'))});
      createJiti(${JSON.stringify(new URL(path, import.meta.url).href)}, { moduleCache: false })
        .transform({ source: 'export {};', filename: 'pi-extension-bootstrap.ts', ts: true });
    `], { cwd: directory, env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
    expect({ code: seed.exitCode, error: seed.stderr.toString() }).toEqual({ code: 0, error: '' });
    const plugin = join(directory, 'extension.ts');
    writeFileSync(plugin, `
      import redirects from ${JSON.stringify(import.meta.resolve('follow-redirects'))};
      export default function(pi) {
        const transformed: number = 1;
        if (transformed !== 1 || typeof redirects.http.request !== 'function') throw new Error('Dependency not initialized');
        pi.registerFlag('loaded', { type: 'boolean', default: true });
        if (${mode === 'plugin'}) Error.prepareStackTrace = () => 'plugin-stack';
      }
    `);
    const program = `
      try {
        const { loadExtensions } = await import(${JSON.stringify(new URL(path, import.meta.url).href)});
        if (${mode === 'host'}) Error.prepareStackTrace = () => 'host-stack';
        const prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
        const stackLimit = Error.stackTraceLimit;
        const loaded = await loadExtensions([${JSON.stringify(plugin)}], ${JSON.stringify(directory)});
        if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
        if (!loaded.extensions[0]?.flags.has('loaded')) throw new Error('Plugin not registered');
        const target = {};
        Error.captureStackTrace(target);
        if (typeof target.stack !== 'string') throw new Error('Stack unavailable');
        if (${mode === 'host'} && target.stack !== 'host-stack') throw new Error('Host formatter unavailable');
        if (${mode === 'plugin'} && target.stack !== 'plugin-stack') throw new Error('Plugin formatter unavailable');
        if (Error.stackTraceLimit !== stackLimit) throw new Error('Host stack limit changed');
        const after = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
        if (${mode !== 'plugin'} && (prepare?.value !== after?.value || prepare?.get !== after?.get
          || prepare?.set !== after?.set)) throw new Error('Host stack formatter changed');
        console.log('plugin dependency and host stack passed');
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    // Fresh processes keep an earlier import of this CommonJS dependency from hiding the defect.
    const child = Bun.spawnSync([process.execPath, '--eval', program], {
      cwd: directory, env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    expect({ code: child.exitCode, error: child.stderr.toString() }).toEqual({ code: 0, error: '' });
    expect(child.stdout.toString()).toContain('plugin dependency and host stack passed');
  });
}
