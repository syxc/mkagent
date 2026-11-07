import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZipArchive } from '../src/pi/utils/zip.ts';
import { extractZipArchive } from '../src/compat/archive.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const samples = [
  [],
  [
    { name: 'report.json', data: '{"version":1}\n' },
    { name: 'diagnostics.json', data: '{"platform":"fixture"}\n' },
    { name: 'session.jsonl', data: '{"type":"fixture"}\n' },
    { name: 'summary.md', data: '# Fixture\n' },
  ],
  [
    { name: '诊断/报告.txt', data: 'UTF-8 中文\n' },
    { name: 'duplicate', data: new Uint8Array([1, 255, 128, 4]).subarray(1, 3) },
    { name: 'duplicate', data: 'second entry' },
    { name: 'empty', data: '' },
  ],
];

for (const [index, entries] of samples.entries()) {
  test(`Native ZIP entries survive an independent standard reader (${index})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-archive-'));
    directories.push(directory);
    const archive = join(directory, 'report.zip');
    await writeZipArchive(archive, entries);
    const reader = Bun.spawnSync(['python3', '-c', [
      'import base64,json,sys,zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as archive:',
      ' print(json.dumps([{"name":entry.filename,"data":base64.b64encode(archive.read(entry)).decode()} for entry in archive.infolist()]))',
    ].join('\n'), archive]);
    expect(reader.exitCode).toBe(0);
    expect(JSON.parse(reader.stdout.toString())).toEqual(entries.map(entry => ({
      name: entry.name, data: (typeof entry.data === 'string' ? Buffer.from(entry.data) : Buffer.from(entry.data)).toString('base64'),
    })));
  });
}

test('Native ZIP rejects classic entry-count overflow and propagates file write errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-archive-error-'));
  directories.push(directory);
  expect(() => writeZipArchive(join(directory, 'overflow.zip'), Array(65_536).fill({ name: 'x', data: '' }))).toThrow(RangeError);
  expect(() => writeZipArchive(join(directory, 'long.zip'), [{ name: 'x'.repeat(65_536), data: '' }])).toThrow(/filename.*long/i);
  expect(await readdir(directory)).toEqual([]);
  await expect(writeZipArchive(join(directory, 'missing', 'report.zip'), [])).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Native ZIP preserves the maximum classic entry count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-archive-limit-'));
  directories.push(directory);
  const archive = join(directory, 'maximum.zip');
  await writeZipArchive(archive, Array(65_535).fill({ name: 'x', data: '' }));
  const reader = Bun.spawnSync(['python3', '-c', [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    ' entries=archive.infolist()',
    ' print(json.dumps([len(entries),all(entry.filename=="x" and entry.compress_type==8 and archive.read(entry)==b"" for entry in entries)]))',
  ].join('\n'), archive]);
  expect(reader.exitCode).toBe(0);
  expect(JSON.parse(reader.stdout.toString())).toEqual([65_535, true]);
}, 15_000);

async function releaseArchive(names: string[], options: { symlink?: boolean; deflate?: boolean; indexed?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-release-'));
  directories.push(directory);
  const archive = join(directory, 'release.zip'), destination = join(directory, 'extracted');
  await mkdir(destination);
  const writer = Bun.spawnSync(['python3', '-c', [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_STORED) as archive:',
    ' for index,name in enumerate(json.loads(sys.argv[2])):',
    '  entry=zipfile.ZipInfo(name)',
    '  if sys.argv[3]=="link": entry.create_system=3; entry.external_attr=0o120777<<16',
    '  entry.compress_type=zipfile.ZIP_DEFLATED if sys.argv[4]=="deflate" else zipfile.ZIP_STORED',
    '  data=bytes.fromhex("00ff")+b"fixture-binary"+bytes.fromhex("80")',
    '  archive.writestr(entry,(bytes([index]) if sys.argv[5]=="indexed" else b"")+data)',
  ].join('\n'), archive, JSON.stringify(names), options.symlink ? 'link' : 'file',
    options.deflate ? 'deflate' : 'stored', options.indexed ? 'indexed' : 'plain']);
  if (writer.exitCode) throw new Error(writer.stderr.toString());
  return { archive, destination, directory };
}

test.each(['fd-v1.2-x86_64-pc-windows-msvc/fd.exe', 'rg.exe'])('ZIP tool extraction retains release paths and bytes (%s)', async name => {
  const fixture = await releaseArchive([name, 'docs/README.md']);
  await extractZipArchive(fixture.archive, fixture.destination, 'release.zip');
  const expected = Buffer.from('00ff666978747572652d62696e61727980', 'hex');
  expect(await readFile(join(fixture.destination, name))).toEqual(expected);
  expect(await readFile(join(fixture.destination, 'docs/README.md'))).toEqual(expected);
});

test('ZIP tool extraction reads independent DEFLATE entries and retains the last normalized filename', async () => {
  const fixture = await releaseArchive(['folder/', './folder/rg.exe', 'folder/rg.exe', 'folder/rg.exe', 'docs/说明.txt'],
    { deflate: true, indexed: true });
  await extractZipArchive(fixture.archive, fixture.destination, 'release.zip');
  expect((await readFile(join(fixture.destination, 'folder/rg.exe'))).toString('hex'))
    .toBe('0300ff666978747572652d62696e61727980');
  expect((await readFile(join(fixture.destination, 'docs/说明.txt'))).toString('hex'))
    .toBe('0400ff666978747572652d62696e61727980');
  expect(await readdir(join(fixture.destination, 'folder'))).toEqual(['rg.exe']);
});

test.each(['../escaped.exe', '/absolute.exe', 'C:\\outside.exe', '..\\escaped.exe'])('ZIP tool extraction rejects unsafe paths before writing (%s)', async name => {
  const fixture = await releaseArchive(['valid.exe', name]);
  await expect(extractZipArchive(fixture.archive, fixture.destination, 'unsafe.zip')).rejects.toThrow('Failed to extract unsafe.zip');
  expect(await readdir(fixture.destination)).toEqual([]);
});

test('ZIP tool extraction checks CRC and rejects symlinks and nonempty destinations', async () => {
  const corrupt = await releaseArchive(['fd.exe']);
  const data = await readFile(corrupt.archive);
  data[data.indexOf('fixture-binary')] ^= 1;
  await writeFile(corrupt.archive, data);
  await expect(extractZipArchive(corrupt.archive, corrupt.destination, 'corrupt.zip')).rejects.toThrow('CRC32');
  expect(await readdir(corrupt.destination)).toEqual([]);
  const link = await releaseArchive(['fd.exe'], { symlink: true });
  await expect(extractZipArchive(link.archive, link.destination, 'link.zip')).rejects.toThrow('Unsupported ZIP entry');
  const used = await releaseArchive(['fd.exe']);
  await writeFile(join(used.destination, 'existing'), 'preserved');
  await expect(extractZipArchive(used.archive, used.destination, 'used.zip')).rejects.toThrow('not empty');
  expect((await readFile(join(used.destination, 'existing'))).toString()).toBe('preserved');
});

function runInstaller(tool: 'fd' | 'rg', fixture: { archive: string; destination: string }) {
  const installer = Bun.spawnSync([process.execPath, new URL('./native-tool-archive.fixture.ts', import.meta.url).pathname,
    tool, fixture.archive, fixture.destination], {
    cwd: fixture.destination, env: { ...process.env, PATH: fixture.destination },
  });
  if (installer.exitCode) throw new Error(installer.stderr.toString());
  return JSON.parse(installer.stdout.toString());
}

test.each(['fd', 'rg'] as const)('Native ensureTool awaits ZIP extraction, installs and cleans up (%s)', async tool => {
  const fixture = await releaseArchive([tool === 'fd' ? 'fd-v1.2-x86_64-pc-windows-msvc/fd.exe' : 'rg.exe']);
  const result = runInstaller(tool, fixture);
  expect(result.installed).toBe(true);
  expect(result.content).toBe('00ff666978747572652d62696e61727980');
  expect(result.files).toEqual([`${tool}.exe`]);
  expect(result.statuses.map((status: { type: string }) => status.type)).toEqual(['info', 'info']);
  expect(result.commands).toEqual(tool === 'fd' ? ['fd', 'fdfind'] : ['rg']);
});

test.each(['fd', 'rg'] as const)('Native ensureTool retains versioned, root and recursive binary precedence (%s)', async tool => {
  const nested = `${tool === 'fd' ? 'fd-v' : 'ripgrep-'}1.2-x86_64-pc-windows-msvc/${tool}.exe`;
  for (const [names, selected] of [
    [[`${tool}.exe`, `other/deep/${tool}.exe`, nested], 2],
    [[`other/deep/${tool}.exe`, `${tool}.exe`], 1],
    [[`other/deep/${tool}.exe`], 0],
  ] as const) {
    const fixture = await releaseArchive([...names], { deflate: true, indexed: true });
    const result = runInstaller(tool, fixture);
    expect(result.installed).toBe(true);
    expect(result.content).toBe(`${selected.toString(16).padStart(2, '0')}00ff666978747572652d62696e61727980`);
    expect(result.files).toEqual([`${tool}.exe`]);
  }
});

test('Native ensureTool cleans up rejected ZIP downloads before reporting the failure', async () => {
  const fixture = await releaseArchive(['fd.exe']);
  const data = await readFile(fixture.archive);
  data[data.indexOf('fixture-binary')] ^= 1;
  await writeFile(fixture.archive, data);
  const result = runInstaller('fd', fixture);
  expect(result.installed).toBe(false);
  expect(result.files).toEqual([]);
  expect(result.statuses.at(-1).message).toContain('CRC32');
});
