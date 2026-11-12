import { readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as stream from 'node:stream';
import * as streamPromises from 'node:stream/promises';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { extractZipArchive } from '../src/compat/archive.ts';
import { writeDownload } from '../src/compat/download.ts';

const [tool, archivePath, installDir] = process.argv.slice(2);
if ((tool !== 'fd' && tool !== 'rg') || !archivePath || !installDir) throw new Error('Missing fixture arguments');
if (process.env.PATH !== installDir || ['fd', 'fdfind', 'rg'].some(name => Bun.which(name) !== null)) {
  throw new Error('Fixture requires an empty initial PATH');
}
const commands: string[] = [], versions: string[] = [];
const modules: Record<string, unknown> = {
  child_process: {
    spawnSync: (command: string) => {
      commands.push(command);
      return { error: new Error('Fixture command unavailable') };
    },
  },
  fs, path, stream, 'stream/promises': streamPromises,
  os: { platform: () => 'win32', arch: () => 'x64' },
  '../config.js': { getBinDir: () => path.join(installDir, 'sdk-default'), VERSION: 'sdk-default' },
  './pi-user-agent.js': { getPiUserAgent: (version: string) => { versions.push(version); return 'fixture'; } },
  './management-http.js': {
    fetchWithRetry: async (url: string) => url.endsWith('/releases/latest')
      ? new Response(null, { status: 302, headers: { location: url.replace('/latest', '/tag/v1.2') } })
      : new Response(await readFile(archivePath)),
  },
};
const sdkPath = await realpath(path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'utils/tools-manager.js'));
if (!sdkPath.endsWith('/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js')) throw new Error('Unexpected SDK alias');
function evaluate(source: string, filename: string, dependencies: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported = {};
  compileFunction(output, ['require', 'exports'], { filename })((name: string) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected installer dependency: ${name}`);
    return dependencies[name];
  }, exported);
  return exported;
}
// Load the actual SDK installer and host binding without following either import closure.
const sdk = evaluate(await readFile(sdkPath, 'utf8'), sdkPath, modules);
const adapterPath = await realpath(new URL('../src/native-search-tools.ts', import.meta.url));
if (!adapterPath.endsWith('/packages/coding-runtime/src/native-search-tools.ts')) throw new Error('Unexpected host alias');
const adapter = evaluate(await readFile(adapterPath, 'utf8'), adapterPath, {
  '@earendil-works/pi-coding-agent': {
    ...sdk,
    createFindTool: (_cwd: string, options: unknown) => options,
  },
  './native-config.ts': { getBinDir: () => installDir, VERSION: 'fixture' },
  './compat/archive.ts': { extractZipArchive },
  './compat/download.ts': { writeDownload },
});
const statuses: Array<{ type: string; message: string }> = [];
process.env.PI_OFFLINE = '0';
const result = await adapter.createFindTool(installDir).ensureTool(tool, (status: { type: string; message: string }) => statuses.push(status));
console.log(JSON.stringify({
  installed: result === path.join(installDir, `${tool}.exe`),
  content: result ? (await readFile(result)).toString('hex') : null,
  files: await readdir(installDir),
  statuses,
  commands,
  versions,
}));
