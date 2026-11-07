import { readFile, readdir, realpath } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as stream from 'node:stream';
import * as streamPromises from 'node:stream/promises';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { extractZipArchive } from '../src/compat/archive.ts';

const [tool, archivePath, installDir] = process.argv.slice(2);
if ((tool !== 'fd' && tool !== 'rg') || !archivePath || !installDir) throw new Error('Missing fixture arguments');
if (process.env.PATH !== installDir || ['fd', 'fdfind', 'rg'].some(name => Bun.which(name) !== null)) {
  throw new Error('Fixture requires an empty initial PATH');
}
const commands: string[] = [];
const modules: Record<string, unknown> = {
  child_process: {
    spawnSync: (command: string) => {
      commands.push(command);
      return { error: new Error('Fixture command unavailable') };
    },
  },
  fs, path, stream, 'stream/promises': streamPromises,
  os: { platform: () => 'win32', arch: () => 'x64' },
  '../config.ts': { getBinDir: () => installDir, VERSION: 'fixture' },
  './pi-user-agent.ts': { getPiUserAgent: () => 'fixture' },
  './management-http.ts': {
    fetchWithRetry: async (url: string) => url.endsWith('/releases/latest')
      ? new Response(null, { status: 302, headers: { location: url.replace('/latest', '/tag/v1.2') } })
      : new Response(await readFile(archivePath)),
  },
  '../../compat/archive.ts': { extractZipArchive },
};
const sourcePath = await realpath(new URL('../src/pi/utils/tools-manager.ts', import.meta.url));
if (!sourcePath.endsWith('/packages/pi-durable-coding/src/pi/utils/tools-manager.ts')) throw new Error('Unexpected source alias');
// Transpile this allowlisted file without following its imports or loading the SDK.
const source = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const statuses: Array<{ type: string; message: string }> = [];
const exported: { ensureTool?: (name: 'fd' | 'rg', status: (value: { type: string; message: string }) => void) => Promise<string | undefined> } = {};
compileFunction(source, ['require', 'exports'], { filename: sourcePath })((name: string) => {
  if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected installer dependency: ${name}`);
  return modules[name];
}, exported);
if (!exported.ensureTool) throw new Error('Native installer export changed');
process.env.PI_OFFLINE = '0';
const result = await exported.ensureTool(tool, status => statuses.push(status));
console.log(JSON.stringify({
  installed: result === path.join(installDir, `${tool}.exe`),
  content: result ? (await readFile(result)).toString('hex') : null,
  files: await readdir(installDir),
  statuses,
  commands,
}));
