import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readHtmlVendorSource } from '../src/compat/html-assets.ts';

const require = createRequire(import.meta.url);
const source = readHtmlVendorSource('highlight.min.js');

test('HTML highlighting uses the published browser build with its BSD notice', () => {
  const browser = readFileSync(require.resolve('@highlightjs/cdn-assets/highlight.min.js'), 'utf8');
  const license = readFileSync(require.resolve('@highlightjs/cdn-assets/LICENSE'), 'utf8');
  assert.ok(source.endsWith(browser));
  assert.ok(source.includes(license));
  assert.equal(runInNewContext(`${source}\nhljs.versionString`), '11.9.0');
});

// Captured from the unmodified Native browser asset before using the package.
const cases = [
  ['typescript', 'const value = 42;', '<span class="hljs-keyword">const</span> value = <span class="hljs-number">42</span>;'],
  ['python', 'print("hello")', '<span class="hljs-built_in">print</span>(<span class="hljs-string">&quot;hello&quot;</span>)'],
  ['json', '{"answer": 42}', '<span class="hljs-punctuation">{</span><span class="hljs-attr">&quot;answer&quot;</span><span class="hljs-punctuation">:</span> <span class="hljs-number">42</span><span class="hljs-punctuation">}</span>'],
  ['bash', 'printf "%s\\n" "$HOME"', '<span class="hljs-built_in">printf</span> <span class="hljs-string">&quot;%s\\n&quot;</span> <span class="hljs-string">&quot;<span class="hljs-variable">$HOME</span>&quot;</span>'],
  ['xml', '<div class="x">&amp;</div>', '<span class="hljs-tag">&lt;<span class="hljs-name">div</span> <span class="hljs-attr">class</span>=<span class="hljs-string">&quot;x&quot;</span>&gt;</span><span class="hljs-symbol">&amp;amp;</span><span class="hljs-tag">&lt;/<span class="hljs-name">div</span>&gt;</span>'],
  ['diff', '-old\n+new\n', '<span class="hljs-deletion">-old</span>\n<span class="hljs-addition">+new</span>\n'],
];
for (const [language, code, html] of cases) {
  test(`offline browser highlighting preserves ${language}`, () => {
    assert.equal(runInNewContext(`${source}\nhljs.highlight(code, { language }).value`, { language, code }), html);
  });
}

test('browser build retains common languages and aliases', () => {
  assert.equal(runInNewContext(`${source}\nhljs.listLanguages().length`), 36);
  assert.equal(runInNewContext(`${source}\n!!hljs.getLanguage('ts') && !!hljs.getLanguage('py') && !hljs.getLanguage('fixture-unknown')`), true);
});

test('offline bundles load the shipped highlighting asset without duplicating the notice', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mkagent-html-highlight-'));
  try {
    mkdirSync(join(directory, 'vendor'));
    const packaged = `/* packaged fixture */\n${source}`;
    writeFileSync(join(directory, 'vendor', 'highlight.min.js'), packaged);
    assert.equal(readHtmlVendorSource('highlight.min.js', directory), packaged);
    assert.equal(runInNewContext(`${readHtmlVendorSource('highlight.min.js', directory)}\nhljs.versionString`), '11.9.0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
