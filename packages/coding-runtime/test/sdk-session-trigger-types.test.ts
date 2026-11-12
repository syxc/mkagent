import { expect, test } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('SDK session preparation uses the published runner trigger type', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const declaration = fileURLToPath(new URL('./core/agent-session.d.ts', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const consumer = join(import.meta.dir, 'sdk-session-trigger-consumer.ts');
  const source = `
import { AgentSession, type BeforeAgentStartTrigger, type CustomMessage } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
class Session extends AgentSession {
  prepare(trigger: BeforeAgentStartTrigger): Promise<AgentMessage[]> {
    return this._prepareRun(trigger);
  }
}
declare const session: Session;
declare const message: CustomMessage;
const user: Promise<AgentMessage[]> = session.prepare({ messageType: 'user', prompt: 'fixture' });
const custom: Promise<AgentMessage[]> = session.prepare({ messageType: 'custom', message });
// @ts-expect-error Custom runs require a message.
session.prepare({ messageType: 'custom', prompt: 'fixture' });
// @ts-expect-error User runs require a prompt.
session.prepare({ messageType: 'user', message });
`;
  const options: ts.CompilerOptions = {
    noEmit: true, strict: true, skipLibCheck: false, allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['bun', 'node'], typeRoots: [join(repo, 'node_modules/@types')],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const excluded = (path: string) => path.split(/[\\/]/).includes('legacy')
    || /(?:^|[\\/])(?:context-tokens\.js|\.env[^/]*|settings[^/]*\.json|auth\.json|credentials?\.json)$/.test(path);
  host.readFile = path => {
    if (path === consumer) return source;
    for (const candidate of [resolve(path), ...(existsSync(path) ? [realpathSync(path)] : [])]) {
      if (excluded(candidate)) throw new Error('Protected type input: ' + candidate);
    }
    return read(path);
  };
  const program = ts.createProgram([declaration, consumer], options, host);
  const sdk = program.getSourceFile(declaration)!;
  const fixture = program.getSourceFile(consumer)!;
  expect(sdk).toBeDefined();
  expect(fixture).toBeDefined();
  // Check the changed declaration without hiding its diagnostics behind skipLibCheck.
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(sdk), ...program.getSemanticDiagnostics(sdk),
    ...program.getSyntacticDiagnostics(fixture), ...program.getSemanticDiagnostics(fixture),
  ];
  expect(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => repo, getNewLine: () => '\n',
  })).toBe('');
}, 20_000);
