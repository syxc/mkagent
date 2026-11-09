import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHostResources } from '../src/host-resources.ts';
import { colorToHex } from '@earendil-works/pi-tui';
import {
  detectColorFgBgTheme, getTerminalTheme, getThemeByName, getThemesDir, loadThemeFromPath,
  type ThemeBg, type ThemeColor,
} from '@earendil-works/pi-coding-agent';

const dark = JSON.parse(readFileSync(join(getThemesDir(), 'dark.json'), 'utf8'));
const light = JSON.parse(readFileSync(join(getThemesDir(), 'light.json'), 'utf8'));
const foregrounds = `accent border borderAccent borderMuted success error warning muted dim text thinkingText
  scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput
  mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet
  toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString
  syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium
  thinkingHigh thinkingXhigh thinkingMax bashMode`.split(/\s+/) as ThemeColor[];
const backgrounds: ThemeBg[] = ['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg'];
const fallbacks = {
  scrollbarTrack: 'muted', scrollbarThumb: 'text', searchMatchBg: 'selectedBg', searchMatchText: 'text', thinkingMax: 'thinkingXhigh',
} as const;

function withThemeDocument(document: unknown, check: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'native-theme-'));
  try {
    const path = join(root, 'theme.json');
    writeFileSync(path, JSON.stringify(document));
    check(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('all public theme names retain their foreground or background slot', () => {
  const names = [...foregrounds, ...backgrounds].sort();
  assert.equal(new Set(names).size, 56);
  for (const document of [dark, light]) {
    assert.deepEqual(Object.keys(document.colors).sort(), names);
    withThemeDocument(document, path => {
      const theme = loadThemeFromPath(path, '256color');
      assert.equal(theme.name, document.name);
      assert.deepEqual(Object.keys(theme.colors).sort(), names);
      for (const token of foregrounds) {
        assert.match(theme.fg(token, 'value'), /^\x1b\[(?:38;|39m)/);
        assert.throws(() => theme.bg(token as unknown as ThemeBg, 'value'), /Unknown theme color/);
      }
      for (const token of backgrounds) {
        assert.match(theme.bg(token, 'value'), /^\x1b\[(?:48;|49m)/);
        assert.throws(() => theme.fg(token as unknown as ThemeColor, 'value'), /Unknown theme color/);
      }
    });
  }
});

test('file themes preserve all optional fallbacks and explicit zero or terminal defaults', () => {
  const document = structuredClone(dark);
  Object.assign(document.colors, { muted: 0, text: '', selectedBg: '', thinkingXhigh: 1 });
  for (const token of Object.keys(fallbacks)) delete document.colors[token];
  withThemeDocument(document, path => {
    const theme = loadThemeFromPath(path, '256color');
    assert.equal(theme.getFgAnsi('scrollbarTrack'), '\x1b[38;5;0m');
    assert.equal(theme.getFgAnsi('scrollbarThumb'), '\x1b[39m');
    assert.equal(theme.getBgAnsi('searchMatchBg'), '\x1b[49m');
    assert.equal(theme.getFgAnsi('searchMatchText'), '\x1b[39m');
    assert.equal(theme.getFgAnsi('thinkingMax'), '\x1b[38;5;1m');
    for (const [token, fallback] of Object.entries(fallbacks)) {
      assert.equal(colorToHex(theme.colors[token as keyof typeof fallbacks]), colorToHex(theme.colors[fallback]));
    }
  });
  Object.assign(document.colors, { scrollbarTrack: '', scrollbarThumb: 0, searchMatchBg: 0, searchMatchText: 0, thinkingMax: '' });
  withThemeDocument(document, path => {
    const theme = loadThemeFromPath(path, '256color');
    assert.equal(theme.getFgAnsi('scrollbarTrack'), '\x1b[39m');
    assert.equal(theme.getFgAnsi('scrollbarThumb'), '\x1b[38;5;0m');
    assert.equal(theme.getBgAnsi('searchMatchBg'), '\x1b[48;5;0m');
    assert.equal(theme.getFgAnsi('searchMatchText'), '\x1b[38;5;0m');
    assert.equal(theme.getFgAnsi('thinkingMax'), '\x1b[39m');
  });
});

test('resource loading reports malformed theme documents and variable chains', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-theme-invalid-'));
  try {
    const documents = [
      { ...dark, name: 'invalid/name' },
      { ...dark, vars: { invalid: 256 } },
      { ...dark, colors: { ...dark.colors, accent: -1 } },
      { ...dark, colors: { ...dark.colors, extra: '#fff' } },
      { ...dark, appearance: 'invalid' },
      { ...dark, export: { extra: '#fff' } },
      { ...dark, extra: true },
      { ...dark, colors: { ...dark.colors, accent: 'missing' } },
      { ...dark, vars: { a: 'b', b: 'a' }, colors: { ...dark.colors, accent: 'a' } },
    ];
    const paths = documents.map((document, index) => {
      const path = join(root, index + '.json');
      writeFileSync(path, JSON.stringify(document));
      return path;
    });
    const { resourceLoader } = createHostResources({
      cwd: root, agentDir: root, resourcePolicy: 'host-only', globalSettings: {}, projectSettings: {}, themePaths: paths,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getThemes().themes, []);
    const diagnostics = resourceLoader.getThemes().diagnostics;
    assert.deepEqual(diagnostics.map(value => value.path).sort(), paths.sort());
    assert.ok(diagnostics.every(value => value.type === 'warning'));
    assert.ok(diagnostics.some(value => value.message.includes('Variable reference not found: missing')));
    assert.ok(diagnostics.some(value => value.message.includes('Circular variable reference detected')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('system palette and dim tokens match the pre-port dark and light output', () => {
  const previous = process.env.COLORFGBG;
  try {
    for (const [value, appearance, foreground, background] of [
      ['15;0', 'dark', '#e5e5e7', '#000000'], ['0;15', 'light', '#000000', '#ffffff'],
      ['invalid', 'dark', '#e5e5e7', '#000000'],
    ] as const) {
      process.env.COLORFGBG = value;
      assert.equal(getTerminalTheme(), appearance);
      const theme = getThemeByName('system')!;
      assert.equal(theme.appearance, appearance);
      assert.equal(colorToHex(theme.colors.text), foreground);
      assert.equal(colorToHex(theme.colors.userMessageBg), background);
      assert.equal(theme.getFgAnsi('muted'), '\x1b[39m\x1b[2m');
      assert.equal(theme.bg('selectedBg', 'value'), '\x1b[49mvalue\x1b[49m');
    }
  } finally {
    if (previous === undefined) delete process.env.COLORFGBG;
    else process.env.COLORFGBG = previous;
  }
  for (let index = 0; index <= 15; index++) {
    assert.equal(detectColorFgBgTheme({ COLORFGBG: `default;0;${index}` }), index <= 6 || index === 8 ? 'dark' : 'light');
  }
  for (const value of ['', 'default', '16', '-1', '001', 'x;invalid']) {
    assert.equal(detectColorFgBgTheme({ COLORFGBG: value }), undefined);
  }
});

test('resource loading rejects incomplete themes without a CLI-installed validator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-theme-'));
  try {
    const path = join(root, 'incomplete.json');
    writeFileSync(path, JSON.stringify({ name: 'incomplete', colors: { muted: 0, text: '', selectedBg: '', thinkingXhigh: 1 } }));
    const { resourceLoader } = createHostResources({
      cwd: root, agentDir: root, resourcePolicy: 'host-only', globalSettings: {}, projectSettings: {}, themePaths: [path],
    });
    await resourceLoader.reload();
    const result = resourceLoader.getThemes();
    assert.deepEqual(result.themes, []);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.path, path);
    assert.match(result.diagnostics[0]?.message ?? '', /Missing required color tokens:[\s\S]*accent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
