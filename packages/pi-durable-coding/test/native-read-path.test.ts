import { expect, mock, test } from 'bun:test';
import { accessSync as liveAccessSync } from 'node:fs';
import { access as liveAccess } from 'node:fs/promises';
import { resolveReadPath, resolveReadPathAsync } from '../src/pi/core/tools/path-utils.ts';

const fs = { ...await import('node:fs') };
const promises = { ...await import('node:fs/promises') };
const root = '/read-path-fixture';
const original = root + "/Capturé d'écran 1.00 PM.png";
const variants = [
  original,
  root + "/Capturé d'écran 1.00\u202FPM.png",
  root + "/Capture\u0301 d'e\u0301cran 1.00 PM.png",
  root + '/Capturé d’écran 1.00 PM.png',
  root + '/Capture\u0301 d’e\u0301cran 1.00 PM.png',
];
type Case = { name: string; input: string; probes: string[]; foundAt?: number; result: string };
const cases: Case[] = [
  ...variants.map((result, foundAt) => ({
    name: `variant ${foundAt}`, input: original, probes: variants.slice(0, foundAt + 1), foundAt, result,
  })),
  { name: 'no variant', input: original, probes: variants, result: original },
  { name: 'unchanged candidates skipped', input: root + '/plain', probes: [root + '/plain'], result: root + '/plain' },
  { name: 'NFD candidate checked again', input: root + '/Café',
    probes: [root + '/Café', root + '/Cafe\u0301', root + '/Cafe\u0301'],
    foundAt: 2, result: root + '/Cafe\u0301' },
  { name: 'curly candidate checked again', input: root + "/d'example",
    probes: [root + "/d'example", root + '/d’example', root + '/d’example'],
    foundAt: 2, result: root + '/d’example' },
];

for (const mode of ['sync', 'async'] as const) {
  test.each(cases.map(row => [row.name, row] as const))(`Native ${mode} read path: %s`, async (_name, row) => {
    const calls: unknown[][] = [];
    const visit = (...args: unknown[]) => {
      calls.push(args);
      if (calls.length - 1 !== row.foundAt) throw new Error('fixture missing');
    };
    const asyncVisit = async (...args: unknown[]) => visit(...args);
    const fsFactory = () => ({ ...fs, accessSync: visit });
    mock.module('node:fs', fsFactory);
    mock.module('fs', fsFactory);
    mock.module('node:fs/promises', () => ({ ...promises, access: asyncVisit }));
    try {
      expect(Object.is(liveAccessSync, visit)).toBe(true);
      expect(Object.is(liveAccess, asyncVisit)).toBe(true);
      const result = mode === 'sync'
        ? resolveReadPath(row.input, root)
        : await resolveReadPathAsync(row.input, root);
      expect(result).toBe(row.result);
      expect(calls).toEqual(row.probes.map(path => [path, fs.constants.F_OK]));
    } finally {
      mock.module('node:fs', () => fs);
      mock.module('fs', () => fs);
      mock.module('node:fs/promises', () => promises);
    }
  });
}

for (const mode of ['sync', 'async'] as const) {
  test(`Native ${mode} read path preserves malformed file URL errors`, async () => {
    if (mode === 'sync') {
      expect(() => resolveReadPath('file://remote-host/path', root)).toThrow();
    } else {
      await expect(resolveReadPathAsync('file://remote-host/path', root)).rejects.toThrow();
    }
  });
}
