import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServerLog, formatMcpLogMessage } from '@mkagent/coding-runtime/mcp-log';

const limit = 5 * 1024 * 1024;
const now = new Date('2026-11-11T00:00:00.000Z');

function fixture(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-log-'));
  try { run(join(directory, 'nested', 'mcp.log')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('log formatting preserves level, logger and indented CRLF and LF lines', () => {
  expect(formatMcpLogMessage('fixture', { level: 'warning', logger: 'worker', data: 'first\r\nsecond\nthird' }, now))
    .toBe('2026-11-11T00:00:00.000Z [fixture] warning worker: first\n    second\n    third\n');
  expect(formatMcpLogMessage('fixture', 'plain', now)).toBe('2026-11-11T00:00:00.000Z [fixture] info plain\n');
  expect(formatMcpLogMessage('fixture', { level: 3, logger: '', data: { ready: true } }, now))
    .toBe('2026-11-11T00:00:00.000Z [fixture] info {"ready":true}\n');
});

test('log formatting retains undefined and non-JSON values', () => {
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const [data, text] of [[undefined, 'undefined'], [null, 'null'], [1n, '1'], [cycle, '[object Object]']] as const) {
    expect(formatMcpLogMessage('fixture', { data }, now)).toBe(`2026-11-11T00:00:00.000Z [fixture] info ${text}\n`);
  }
});

test('log creation uses the host path and appends synchronously from separate instances', () => fixture(path => {
  const first = new McpServerLog(path), second = new McpServerLog(path);
  expect(first.path).toBe(path);
  first.write('one', { data: 'first' }); second.write('two', { data: 'second' });
  expect(readFileSync(path, 'utf8').replace(/^[^ ]+ /gm, '')).toBe('[one] info first\n[two] info second\n');
}));

test('rotation starts after the exact byte limit and preserves the previous file', () => fixture(path => {
  const log = new McpServerLog(path); log.write('fixture', { data: 'seed' });
  writeFileSync(path, Buffer.alloc(limit, 'x'));
  const fresh = new McpServerLog(path); fresh.write('fixture', { data: 'at-limit' });
  expect(statSync(path).size).toBeGreaterThan(limit);
  expect(() => statSync(path + '.1')).toThrow();
  fresh.write('fixture', { data: 'after-limit' });
  expect(statSync(path + '.1').size).toBeGreaterThan(limit);
  expect(readFileSync(path + '.1', 'utf8').endsWith('[fixture] info at-limit\n')).toBe(true);
  expect(readFileSync(path, 'utf8').endsWith('[fixture] info after-limit\n')).toBe(true);
}));

test('rotation counts UTF-8 bytes and rechecks an externally rotated file', () => fixture(path => {
  new McpServerLog(path).write('fixture', { data: 'seed' });
  writeFileSync(path, Buffer.alloc(limit - 80, 'x'));
  const log = new McpServerLog(path); log.write('fixture', { data: '界'.repeat(20) });
  expect(statSync(path).size).toBeGreaterThan(limit);
  renameSync(path, path + '.1'); writeFileSync(path, 'external\n');
  log.write('fixture', { data: 'after-external' });
  expect(readFileSync(path, 'utf8').startsWith('external\n')).toBe(true);
  expect(statSync(path + '.1').size).toBeGreaterThan(limit);
}));

test('filesystem failures do not interrupt tools and a later write can recover', () => fixture(path => {
  new McpServerLog(path).write('fixture', { data: 'seed' });
  // A regular file cannot be used as the parent of another log file.
  const blocked = new McpServerLog(join(path, 'child'));
  expect(() => blocked.write('fixture', { data: 'ignored' })).not.toThrow();
  rmSync(path);
  expect(() => blocked.write('fixture', { data: 'recovered' })).not.toThrow();
  expect(readFileSync(join(path, 'child'), 'utf8').endsWith('[fixture] info recovered\n')).toBe(true);
}));
