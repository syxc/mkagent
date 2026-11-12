import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ansiLinesToHtml, ansiToHtml, exportSessionToHtml, createToolHtmlRenderer } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { getThemeByName, getThemesDir, loadThemeFromPath, setRegisteredThemes } from '@earendil-works/pi-coding-agent';

const indices = [...Array.from({ length: 256 }, (_, index) => String(index)), '256', '65535', '9'.repeat(40), '9'.repeat(400)];
const samples = indices.flatMap(index => [38, 48].map(channel => `before\x1b[1;${channel};5;${index}m<&"'\x1b[0mafter`));
samples.push(...Array.from({ length: 111 }, (_, code) => `a\x1b[${code}m<&\x1b[0mz`), '', 'plain <&"\'', '\x1b[mreset', '\x1b[38;2;1;2;3mRGB\x1b[48;2;254;255;256mBG');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Captured from the unmodified Pi 1.5.0 renderer before sharing the palette.
test('ANSI HTML keeps the original palette, SGR, escaping and wide numeric behavior', () => {
  assert.equal(samples.length, 635);
  assert.equal(digest(samples.map(ansiToHtml)), '857a2648ec8af7a9c052196e2be1e7c01ab35f2c46552e4e12c94320e32607cc');
  assert.equal(digest(ansiLinesToHtml(samples)), '196baaa44af3e50fd449859ada4733a3bd583609f733216a2d301b7460b4c3b4');
  assert.equal(ansiToHtml('\x1b[38;5;256mwide'), '<span style="color:#f8f8f8">wide</span>');
});

test('session HTML export preserves custom tool call and result colors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mkagent-html-colors-'));
  try {
    const theme = getThemeByName('system');
    assert.ok(theme);
    const toolRenderer = createToolHtmlRenderer({
      theme, cwd: root,
      getToolRenderers: () => ({
        renderCall: () => ({ render: () => ['\x1b[48;5;21m<&\x1b[0m'], invalidate() {} }),
        renderResult: (_result, options) => ({
          render: () => ['', `\x1b[38;5;${options.expanded ? 196 : 46}mresult\x1b[0m`, ''],
          invalidate() {},
        }),
      }),
    });
    const session = SessionManager.create(root, root);
    session.appendMessage({
      role: 'assistant', api: 'fixture', provider: 'fixture', model: 'fixture', timestamp: 1, stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'color-call', name: 'custom-colors', arguments: {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    session.appendMessage({
      role: 'toolResult', toolCallId: 'color-call', toolName: 'custom-colors', timestamp: 2,
      content: [{ type: 'text', text: 'result' }], isError: false,
    });
    const output = await exportSessionToHtml(session, undefined, {
      outputPath: join(root, 'session.html'), themeName: 'system', toolRenderer,
    });
    const payload = readFileSync(output, 'utf8').match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    assert.ok(payload);
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    assert.deepEqual(data.renderedTools['color-call'], {
      callHtml: '<div class="ansi-line"><span style="background-color:#0000ff">&lt;&amp;</span></div>',
      resultHtmlCollapsed: '<div class="ansi-line"><span style="color:#00ff00">result</span></div>',
      resultHtmlExpanded: '<div class="ansi-line"><span style="color:#ff0000">result</span></div>',
    });

    const document = JSON.parse(readFileSync(join(getThemesDir(), 'dark.json'), 'utf8'));
    document.name = 'fixture';
    document.appearance = 'light';
    document.vars = { ...document.vars, red: 196, alias: 'red', panel: '#123456' };
    Object.assign(document.colors, { accent: 'alias', searchMatchBg: 'panel', toolOutput: '#abcdef', userMessageBg: '#202020' });
    for (const explicit of [false, true]) {
      document.export = explicit ? { pageBg: 'panel', cardBg: 0, infoBg: '' } : {};
      const path = join(root, 'fixture.json');
      writeFileSync(path, JSON.stringify(document));
      const custom = loadThemeFromPath(path, 'truecolor');
      assert.equal(custom.appearance, 'light');
      setRegisteredThemes([custom]);
      const renderer = createToolHtmlRenderer({
        theme: custom, cwd: root,
        getToolRenderers: () => ({
          renderCall: () => ({ render: () => [custom.style('<&', { fg: 'accent', bg: 'searchMatchBg' })], invalidate() {} }),
          renderResult: (_result, options) => ({
            render: () => [custom.fg('toolOutput', options.expanded ? 'expanded' : 'collapsed')], invalidate() {},
          }),
        }),
      });
      const customOutput = await exportSessionToHtml(session, undefined, {
        outputPath: join(root, `theme-${explicit}.html`), themeName: 'fixture', toolRenderer: renderer,
      });
      const html = readFileSync(customOutput, 'utf8');
      assert.ok(html.includes('--accent: #ff0000;'));
      assert.ok(html.includes('--searchMatchBg: #123456;'));
      assert.ok(html.includes(`--exportPageBg: ${explicit ? '#123456' : 'rgb(22, 22, 22)'};`));
      assert.ok(html.includes(`--exportCardBg: ${explicit ? '#000000' : 'rgb(27, 27, 27)'};`));
      assert.ok(html.includes('--exportInfoBg: rgb(52, 47, 32);'));
      const payload = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
      assert.ok(payload);
      const rendered = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).renderedTools['color-call'];
      assert.match(rendered.callHtml, /color:#ff0000/);
      assert.match(rendered.callHtml, /background-color:rgb\(18,52,86\)/);
      assert.match(rendered.callHtml, /&lt;&amp;/);
      assert.match(rendered.resultHtmlCollapsed, /color:rgb\(171,205,239\)">collapsed/);
      assert.match(rendered.resultHtmlExpanded, /color:rgb\(171,205,239\)">expanded/);
    }
  } finally {
    setRegisteredThemes([]);
    rmSync(root, { recursive: true, force: true });
  }
});
