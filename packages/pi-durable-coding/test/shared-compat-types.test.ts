import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

test('legacy shared classes keep existing structural consumers and declaration output', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const coding = join(repo, 'packages/pi-durable-coding');
  const directory = mkdtempSync(join(tmpdir(), 'shared-compat-types-'));
  const consumer = join(directory, 'consumer.ts');
  const originalRead = ts.sys.readFile;
  // Check real source types without following a restricted module through an alias.
  ts.sys.readFile = file => {
    let actual = file;
    try { actual = realpathSync(file); } catch {}
    if ([file, actual].some(path => /[\\/]runtime-credentials\.ts$/i.test(path))) {
      throw new Error('Restricted source blocked before reading');
    }
    return originalRead(file);
  };
  try {
    writeFileSync(consumer, `
import { DefaultPackageManager } from "${coding}/src/upstream/core/package-manager.ts";
import { resolveCodingPackages, type ResourceSettings } from "${coding}/src/packages.ts";
import { mergeCodingSettings } from "${coding}/src/upstream/core/settings-merge.js";
import { convertToLlm } from "${coding}/src/upstream/core/messages.js";
import { SessionManager, buildSessionProjection } from "${coding}/src/upstream/core/session-manager.js";
import { estimateTokens, calculateContextTokens } from "${coding}/src/upstream/core/context-tokens.js";
import type { ToolDefinition } from "${repo}/node_modules/@earendil-works/pi-coding-agent";
import type { BeforeAgentStartTrigger, NewSessionHandler } from "${coding}/src/legacy/extension-runner.js";
const safeReplay: ToolDefinition["replay"] = "safe";
const neverReplay: ToolDefinition["replay"] = "never";
// @ts-expect-error Unsupported replay policies must not compile.
const invalidReplay: ToolDefinition["replay"] = "unsafe";
const trigger: BeforeAgentStartTrigger = { messageType: "user", prompt: "fixture" };
const newSession: NewSessionHandler = async () => ({ cancelled: false });
const session = SessionManager.inMemory("/tmp/fixture", undefined, []);
session.appendMessage({ role: "user", content: "fixture", timestamp: 1, hostMessageId: "fixture" });
const projection = buildSessionProjection(session.getEntries());
const entryIds = session.getEntries().map(entry => entry.id);
const roles = projection.messages.map(message => message.role);
const contextRoles = session.buildSessionContext().messages.map(message => message.role);
const branchIds = session.getBranch().map(entry => entry.id);
const formattedId = session.getSessionId().replace(/./g, character => character);
async function inspectList() {
  return (await SessionManager.list("/tmp/fixture", "/tmp/fixture/sessions")).map(info => info.id);
}
const hostId: string = convertToLlm([{ role: "user", content: "fixture", timestamp: 1, hostMessageId: "fixture" }])[0].hostMessageId;
const tokens: number = estimateTokens({ role: "user", content: "fixture", hostMessageId: "fixture" });
const usage: number = calculateContextTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
const merged = mergeCodingSettings({ custom: { enabled: true } }, { custom: { count: 2 } });
const count: number = merged.custom.count;
const data: ResourceSettings = { packages: ["./fixture"], prompts: ["review.md"] };
const settings = {
  getGlobalSettings: () => data, getProjectSettings: () => data,
  setPackages: (_packages: NonNullable<ResourceSettings["packages"]>) => {},
  setProjectPackages: (_packages: NonNullable<ResourceSettings["packages"]>) => {},
  isProjectTrusted: () => true, getNpmCommand: () => undefined,
};
const options = { cwd: "/tmp/fixture", agentDir: "/tmp/fixture/agent", settingsManager: settings };
new DefaultPackageManager(options).resolve(async () => "skip");
resolveCodingPackages({ ...options, projectTrusted: true });
`);
    const program = ts.createProgram([consumer], {
      strict: true, skipLibCheck: true, allowJs: true, checkJs: false,
      allowImportingTsExtensions: true, target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: ['bun-types'], typeRoots: [join(repo, 'node_modules/@types'), join(repo, 'node_modules')],
      declaration: true, emitDeclarationOnly: true, outDir: join(directory, 'declarations'),
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: file => file, getCurrentDirectory: () => repo, getNewLine: () => '\n',
    })).toBe('');
    const declarations = new Map<string, string>();
    const result = program.emit(undefined, (file, content) => declarations.set(file, content));
    expect(result.emitSkipped).toBe(false);
    expect(result.diagnostics).toHaveLength(0);
    expect([...declarations.keys()].some(file => file.endsWith('src/legacy/session-manager.d.ts'))).toBe(true);
  } finally {
    ts.sys.readFile = originalRead;
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
