import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Text, type TUI } from '@earendil-works/pi-tui';
import * as native from '../src/native.ts';
import * as compat from '../src/compat.ts';
import * as ui from '../src/native-ui.ts';
import { VIRTUAL_MODULES } from '../src/pi/core/extensions/virtual-modules.ts';
import { codingHostImport, codingSDKImport } from '../scripts/coding-sdk-imports.ts';

test('public UI uses SDK components and keeps host-only entry points private', () => {
  for (const [name, value] of Object.entries(ui)) {
    for (const entry of [native, VIRTUAL_MODULES['@earendil-works/pi-coding-agent'],
      VIRTUAL_MODULES['@mariozechner/pi-coding-agent']]) expect((entry as any)[name]).toBe(value);
    if (name !== 'ToolExecutionComponent') expect(value).toBe((sdk as any)[name]);
  }
  expect(Object.getPrototypeOf(ui.ToolExecutionComponent.prototype)).toBe(sdk.ToolExecutionComponent.prototype);
  for (const name of ['main', 'InteractiveMode', 'runPrintMode', 'runRpcMode',
    'FirstTimeSetupComponent', 'ScopedModelsSelectorComponent', 'TrustSelectorComponent']) {
    expect(name in native).toBe(false);
    expect(name in compat).toBe(false);
    expect(name in ui).toBe(false);
  }
  expect(sdk.AuthUrlComponent).toBeFunction();
  expect(sdk.VisualLinePreview).toBeFunction();
  expect(codingHostImport('index.ts', './modes/interactive/components/index.ts')).toBe('../native-ui.ts');
  for (const name of ['auth-url', 'dynamic-border', 'keybinding-hints', 'visual-truncate']) {
    expect(codingSDKImport('extensions/mcp/ui.ts', `../../modes/interactive/components/${name}.ts`))
      .toBe('@earendil-works/pi-coding-agent');
  }
});

for (const renderShell of ['default', 'self'] as const) {
  test(`${renderShell} renderers keep state, argument batching, partial results and mouse expansion`, () => {
    sdk.initTheme(undefined, false);
    let renders = 0;
    const calls: sdk.ToolRenderContext[] = [];
    const results: sdk.ToolRenderContext[] = [];
    const call = new Text('call', 0, 0);
    const result = new Text('result', 0, 0);
    const options = Object.freeze(Object.create({ showImages: false, outputPad: 3 }));
    const tool = new ui.ToolExecutionComponent('fixture', 'ui-call', { value: 0 }, options, {
      renderShell,
      renderCall(args, _theme, context) {
        calls.push(context);
        context.state.count = Number(context.state.count ?? 0) + 1;
        call.setText(`call ${args.value}`);
        return call;
      },
      renderResult(output, _options, _theme, context) {
        results.push(context);
        result.setText(`result ${output.content.filter(item => item.type === 'text').map(item => item.text).join(' ')}`);
        return result;
      },
    }, { requestRender() { renders++; } } as TUI, '/fixture-cwd');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolCallId: 'ui-call', cwd: '/fixture-cwd',
      argsComplete: false, executionStarted: false, showImages: false, outputPad: 3 });
    tool.updateArgs({ value: 1 });
    tool.updateArgs({ value: 2 });
    expect(calls).toHaveLength(1);
    expect(tool.render(60).join('\n')).toContain('call 2');
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)!.lastComponent).toBe(call);
    expect(calls.at(-1)!.args).toEqual({ value: 2 });
    tool.markExecutionStarted();
    tool.setArgsComplete();
    expect(calls.at(-1)).toMatchObject({ argsComplete: true, executionStarted: true });
    tool.updateResult({ content: [{ type: 'text', text: 'partial' }], isError: false, durationMs: 99 }, true);
    expect(results.at(-1)).toMatchObject({ isPartial: true, isError: false, durationMs: undefined });
    tool.updateResult({ content: [{ type: 'text', text: 'done' }], details: { kept: true }, isError: true, durationMs: 7 });
    expect(results.at(-1)).toMatchObject({ isPartial: false, isError: true, durationMs: 7 });
    expect(results.at(-1)!.lastComponent).toBe(result);
    expect([...calls, ...results].every(context => context.state === calls[0]!.state)).toBe(true);
    expect(results.at(-1)!.state.count).toBe(calls.length);
    const lines = tool.render(60);
    const row = lines.findIndex(line => line.includes('result done'));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(tool.handleMouse({ type: 'click', button: 'left', x: 4, y: row, screenX: 4, screenY: row,
      shift: false, alt: false, ctrl: false, width: 60, height: lines.length }))
      .toMatchObject({ handled: true });
    expect(results.at(-1)!.expanded).toBe(true);
    tool.setExpanded(false);
    tool.setOutputPad(0);
    tool.setShowImages(true);
    expect(results.at(-1)).toMatchObject({ expanded: false, outputPad: 0, showImages: true });
    const before = renders;
    results.at(-1)!.invalidate();
    expect(renders).toBe(before + 1);
    expect(results.at(-1)!.lastComponent).toBe(result);
    expect(tool.render(60).join('\n')).toContain('result done');
  });
}

test('renderer errors retain the SDK fallback output', () => {
  sdk.initTheme(undefined, false);
  const tool = new ui.ToolExecutionComponent('fallback', 'fallback-call', { value: 'kept' }, undefined, {
    renderCall() { throw new Error('call renderer failed'); },
    renderResult() { throw new Error('result renderer failed'); },
  }, { requestRender() {} } as TUI, '/fixture-cwd');
  tool.updateResult({ content: [{ type: 'text', text: 'fallback output' }], isError: true });
  const lines = tool.render(60).join('\n');
  expect(lines).toContain('fallback');
  expect(lines).toContain('kept');
  expect(lines).toContain('fallback output');
});

for (const mode of ['native', 'sdk'] as const) {
  test(`${mode} renderer converts non-PNG images with its default asset binding`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'ui-image-'));
    try {
      const run = Bun.spawnSync([process.execPath, '--no-env-file', '--config=/dev/null',
        join(import.meta.dir, 'fixtures/ui-image.ts'), ...(mode === 'sdk' ? ['--sdk'] : [])], {
        cwd: directory, env: { PATH: process.env.PATH!, HOME: directory, PI_OFFLINE: '1', NO_COLOR: '1' },
        timeout: 10_000,
      });
      expect({ code: run.exitCode, error: run.stderr.toString() }).toEqual({ code: 0, error: '' });
      expect(JSON.parse(run.stdout.toString())).toEqual({ mode, png: true, cache: true, visibility: true });
    } finally {
      expect(Bun.spawnSync(['trash', directory]).exitCode).toBe(0);
    }
  });
}

test('relocated renderer uses the adjacent shared Photon without project dependencies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ui-image-bundle-'));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, 'fixtures/ui-image.ts')], outdir: directory,
      naming: '[name].js', target: 'bun', format: 'esm', external: ['@silvia-odwyer/photon-node'],
    });
    expect(build.success).toBe(true);
    expect(existsSync(join(directory, 'node_modules'))).toBe(false);
    copyFileSync(createRequire(import.meta.url).resolve('@silvia-odwyer/photon/photon_rs_bg.wasm'),
      join(directory, 'photon_rs_bg.wasm'));
    const preload = join(directory, 'offline.ts');
    writeFileSync(preload, `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const fs = createRequire(import.meta.url)('node:fs/promises');
      const read = fs.readFile;
      fs.readFile = (path, ...args) => {
        if (String(path).includes('node_modules') && String(path).endsWith('photon_rs_bg.wasm')) {
          return Promise.reject(Object.assign(new Error('Build-machine Photon is unavailable'), { code: 'ENOENT' }));
        }
        return read(path, ...args);
      };
      syncBuiltinESMExports();
      globalThis.fetch = () => { throw new Error('Unexpected network request'); };
    `);
    const run = Bun.spawnSync([process.execPath, '--no-env-file', '--config=/dev/null', '--preload', preload,
      join(directory, 'ui-image.js')], {
      cwd: directory, env: { PATH: process.env.PATH!, HOME: directory, PI_OFFLINE: '1', NO_COLOR: '1' },
      timeout: 10_000,
    });
    expect({ code: run.exitCode, error: run.stderr.toString() }).toEqual({ code: 0, error: '' });
    expect(JSON.parse(run.stdout.toString())).toEqual({ mode: 'native', png: true, cache: true, visibility: true });
  } finally {
    expect(Bun.spawnSync(['trash', directory]).exitCode).toBe(0);
  }
});
