import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { portHtmlMarked } from '../scripts/asset-runtime-port.ts';
import { readMarkedSource } from '../src/compat/html-marked.ts';

const require = createRequire(import.meta.url);
const packagePath = require.resolve('marked/package.json');
const packageInfo = JSON.parse(readFileSync(packagePath, 'utf8'));

test('HTML Markdown uses the browser entry declared by the installed package', () => {
  const browser = readFileSync(join(dirname(packagePath), packageInfo.browser), 'utf8');
  assert.equal(packageInfo.version, '18.0.11');
  assert.equal(readMarkedSource(), browser.slice(0, browser.indexOf('//# sourceMappingURL=')));
  assert.ok(!readMarkedSource().includes('sourceMappingURL'));
});

const cases = [
  ['# Title', '<h1>Title</h1>\n'],
  ['**bold** and *italic*', '<p><strong>bold</strong> and <em>italic</em></p>\n'],
  ['[link](https://example.test)', '<p><a href="https://example.test">link</a></p>\n'],
  ['- one\n- two', '<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n'],
  ['~~removed~~', '<p><del>removed</del></p>\n'],
  ['`<tag>`', '<p><code>&lt;tag&gt;</code></p>\n'],
  ['中文段落', '<p>中文段落</p>\n'],
];
for (const [markdown, html] of cases) {
  test(`offline browser Markdown: ${markdown}`, () => {
    const context = { input: markdown };
    assert.equal(runInNewContext(`${readMarkedSource()}\nmarked.parse(input)`, context), html);
  });
}

test('offline bundles use their shipped browser asset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mkagent-html-marked-'));
  try {
    mkdirSync(join(directory, 'vendor'));
    const source = `/* packaged fixture */\n${readMarkedSource()}`;
    writeFileSync(join(directory, 'vendor', 'marked.min.js'), source);
    assert.equal(readMarkedSource(directory), source);
    assert.equal(runInNewContext(`${readMarkedSource(directory)}\nmarked.parse('# Offline')`), '<h1>Offline</h1>\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTML asset port rejects missing or repeated asset reads', () => {
  const source = 'const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");';
  const output = portHtmlMarked(source);
  assert.match(output, /const markedJs = readMarkedSource\(templateDir\);/);
  assert.throws(() => portHtmlMarked(''), /boundary changed/);
  assert.throws(() => portHtmlMarked(`${source}\n${source}`), /boundary changed/);
});
