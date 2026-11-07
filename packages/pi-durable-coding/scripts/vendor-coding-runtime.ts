/** Reproduce the complete public Pi coding source closure with a replaceable execution boundary. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { portModelRuntime, portProviderComposer } from './model-runtime-port.ts';
import { portResourceLoader } from './resource-loader-port.ts';
import { portMcpOAuth } from './mcp-oauth-port.ts';
import { portBundledAssets, portImageAssets } from './asset-runtime-port.ts';
import { portAgentSession, portCacheWarmer, portNativeMessages, portSDK, portSessionServices, portToolDefinition } from './session-runtime-port.ts';
import { portAgentFacade } from './agent-facade-port.ts';
import { portSharedHelpers } from './shared-helper-port.ts';
import { portCompatRuntime } from './compat-runtime-port.ts';

const revision = 'f9a26365568127461c47a07a37dcb42c140a3ac5';
const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: bun vendor-coding-runtime.ts /absolute/pi-checkout [--inventory|--check]');
const upstream = resolve(checkout);
const source = join(upstream, 'packages/coding-agent/src');
const destination = resolve(import.meta.dir, '..');
const checking = process.argv.includes('--check');
const inventory = process.argv.includes('--inventory');
const options = process.argv.slice(3);
const selected = options.filter(value => value.startsWith('--file=')).map(value => value.slice('--file='.length));
for (const option of options) {
  if (option !== '--check' && option !== '--inventory' && !option.startsWith('--file=')) throw new Error(`Unknown option: ${option}`);
}
if (selected.length && (!checking || inventory)) throw new Error('--file requires --check and cannot generate a partial inventory');
for (const file of selected) {
  if (!/^[\w/-]+(?:\.d)?\.ts$/.test(file) || file.split('/').includes('..') || file.startsWith('/') ||
      file.split('/').at(-1)?.toLowerCase() === 'runtime-credentials.ts') throw new Error(`Source is not permitted for a scoped check: ${file}`);
}
const scoped = selected.length > 0;
const head = Bun.spawnSync(['git', '-C', upstream, 'rev-parse', 'HEAD']);
const status = Bun.spawnSync(['git', '-C', upstream, 'status', '--porcelain', '--',
  ...(scoped ? [...selected.map(file => 'packages/coding-agent/src/' + file), 'packages/coding-agent/package.json', 'LICENSE']
    : ['packages/coding-agent/src', 'packages/coding-agent/package.json', 'packages/agent/src', 'LICENSE'])]);
if (head.exitCode || head.stdout.toString().trim() !== revision || status.exitCode || status.stdout.toString().trim()) {
  throw new Error('Expected clean pinned Pi v1.5.0 sources');
}
const packageInfo = JSON.parse(readFileSync(join(upstream, 'packages/coding-agent/package.json'), 'utf8'));
const localDependencies = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).dependencies;
const queue = scoped ? [...new Set(selected)] : ['index.ts', 'core/agent-session-services.ts', 'extensions/codemode/worker.ts', 'utils/image-resize-worker.ts', 'utils/highlight-js.d.ts'];
const visited = new Set<string>();
const dependencies = new Set<string>();
const coreImports = new Set<string>();
const records: Array<{ source: string; target: string; sha256: string; portSha256: string; changes: string[] }> = [];
const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const slash = (path: string) => path.split(sep).join('/');

function save(path: string, body: string | Uint8Array) {
  if (inventory) return;
  const target = join(destination, path);
  if (checking) {
    if (hash(readFileSync(target)) !== hash(body)) throw new Error(`Source output differs: ${path}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

while (queue.length) {
  const path = queue.shift()!;
  if (visited.has(path)) continue;
  visited.add(path);
  const original = readFileSync(join(source, path), 'utf8');
  const parsed = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true);
  const replacements: Array<{ start: number; end: number; body: string }> = [];
  const changes = new Set<string>();
  const inspect = (literal: ts.StringLiteralLike) => {
    const specifier = literal.text;
    if (specifier === '@earendil-works/pi-agent-core') {
      // Public protocol types do not cross the execution boundary.
      if (ts.isImportDeclaration(literal.parent) && literal.parent.importClause?.isTypeOnly) {
        dependencies.add(specifier);
        return;
      }
      let target = slash(relative(dirname(join(destination, 'src/pi', path)), join(destination, 'src/agent-runtime.ts')));
      if (!target.startsWith('.')) target = './' + target;
      replacements.push({ start: literal.getStart(parsed), end: literal.end, body: JSON.stringify(target) });
      changes.add('durable-agent-boundary');
      return;
    }
    if (specifier.startsWith('.')) {
      if (scoped) return;
      const candidate = resolve(dirname(join(source, path)), specifier);
      if (!candidate.startsWith(source + sep)) throw new Error(`Relative import escapes coding sources: ${path}: ${specifier}`);
      const selected = existsSync(candidate) && extname(candidate) ? candidate
        : existsSync(candidate + '.ts') ? candidate + '.ts' : join(candidate, 'index.ts');
      if (!existsSync(selected)) throw new Error(`Missing source import: ${path}: ${specifier}`);
      queue.push(slash(relative(source, selected)));
      return;
    }
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
    // Bun treats undici as built in, but Node consumers still require the pinned package.
    if (packageInfo.dependencies[name] || !isBuiltin(specifier)) dependencies.add(name);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === '@earendil-works/pi-agent-core' && ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) coreImports.add((item.propertyName ?? item.name).text);
        else coreImports.add('*');
      }
      inspect(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      inspect(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      inspect(node.arguments[0]);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // Message declaration merging belongs to the public protocol package.
      if (node.name.text === '@earendil-works/pi-agent-core') dependencies.add(node.name.text);
      else inspect(node.name);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && !node.arguments[0].text.startsWith('.')) {
      const name = node.arguments[0].text.split('/')[0]!;
      if (packageInfo.dependencies[name]) inspect(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let body = original;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.body + body.slice(edit.end);
  if (path === 'core/resource-loader.ts' || path === 'core/package-manager.ts') {
    body = portResourceLoader(path, body);
    changes.add('host-resource-trust-and-installed-package-policy');
  }
  if (path === 'core/package-manager.ts') {
    changes.add('explicit-host-project-resource-directory');
    changes.add('structural-package-settings-interface');
  }
  if (path === 'core/skills.ts' || path === 'core/prompt-templates.ts') {
    body = portResourceLoader(path, body);
    changes.add('explicit-host-project-resource-directory');
  }
  if (path === 'core/model-runtime.ts') {
    body = portModelRuntime(body);
    changes.add('host-owned-models-and-credentials');
  }
  if (path === 'core/provider-composer.ts') {
    body = portProviderComposer(body);
    changes.add('structural-provider-config-interface');
  }
  if (path === 'core/settings-manager.ts') {
    const declaration = 'function deepMergeSettings(';
    if (!body.includes(declaration)) throw new Error('Shared settings merge changed');
    body = body.replace(declaration, 'export ' + declaration);
    changes.add('shared-settings-merge');
  }
  if (path === 'core/agent-session.ts') {
    body = portAgentSession(body);
    changes.add('durable-recovery-and-host-tool-policy');
    changes.add('host-current-system-prompt-before-agent-start');
  }
  if (path === 'core/messages.ts') {
    body = portNativeMessages(body);
    changes.add('exclude-host-correlation-from-model-context');
    changes.add('legacy-projection-message-policy');
  }
  if (path === 'core/sdk.ts') {
    body = portSDK(body);
    changes.add('durable-sdk-host-bindings');
  }
  if (path === 'core/cache-warmer.ts') {
    body = portCacheWarmer(body);
    changes.add('host-background-action-and-usage-receipt');
  }
  if (path === 'core/agent-session-services.ts') {
    body = portSessionServices(body);
    changes.add('shared-extension-model-initialization');
  }
  if (path === 'extensions/mcp/oauth.ts') {
    body = portMcpOAuth(body);
    changes.add('cancellable-host-oauth-refresh-lock');
  }
  if (path === 'utils/image-resize.ts' || path === 'utils/photon.ts') {
    body = portImageAssets(path, body);
    changes.add('installed-image-worker-and-versioned-bundle-wasm');
  }
  if (path === 'utils/abort.ts') {
    const exports = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node)
      || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)));
    if (exports.length !== 2 || new Set(exports.map(node => ts.isFunctionDeclaration(node) ? node.name?.text : undefined)).size !== 2
      || !exports.every(node => ts.isFunctionDeclaration(node)
      && ((node.name?.text === 'operationSignal' && node.parameters.length === 1)
        || (node.name?.text === 'raceWithAbortSignal' && node.parameters.length === 2)))) {
      throw new Error('Public cancellation API changed; review the optional-signal compatibility wrapper');
    }
    body = `import { raceWithAbortSignal as race } from "@earendil-works/pi-ai/utils/abort";
export { operationSignal } from "@earendil-works/pi-ai/utils/abort";

/** Retain the coding API's optional signal over the public shared implementation. */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
\treturn signal ? race(operation, signal) : operation;
}
`;
    changes.add('public-pi-ai-abort-helper');
  }
  if (path === 'utils/sleep.ts') {
    const exports = parsed.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node)
      || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)));
    const sleep = exports[0];
    if (exports.length !== 1 || !sleep || !ts.isFunctionDeclaration(sleep) || sleep.name?.text !== 'sleep'
      || sleep.parameters.length !== 2 || sleep.type?.getText(parsed) !== 'Promise<void>'
      || sleep.parameters[0].type?.kind !== ts.SyntaxKind.NumberKeyword
      || sleep.parameters[1].type?.getText(parsed) !== 'AbortSignal' || !sleep.parameters[1].questionToken) {
      throw new Error('Public sleep API changed; review the optional-signal and cancellation-error wrapper');
    }
    body = `import { sleep as sharedSleep } from "@earendil-works/pi-ai/utils/sleep";

/** Keep the coding API's optional signal and cancellation error over the shared timer. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
\treturn sharedSleep(ms, signal ?? new AbortController().signal).catch((error: unknown) => {
\t\tif (signal?.aborted && Object.is(error, signal.reason)) throw new Error("Aborted");
\t\tthrow error;
\t});
}
`;
    changes.add('public-pi-ai-sleep-helper');
  }
  if (path === 'core/extensions/types.ts' || path === 'core/tools/tool-definition-wrapper.ts') {
    body = portToolDefinition(path, body);
    changes.add('explicit-durable-tool-replay-policy');
  }
  if (path === 'core/tools/find.ts') {
    body = body.replace('path.PlatformPath', 'typeof path');
    changes.add('node-path-platform-type');
  }
  if (path === 'core/extensions/loader.ts') {
    const before = 'const usesEmbeddedModules = isBunBinary || isNodeSeaBinary || isBundledNode;';
    if (!body.includes(before)) throw new Error('Extension module resolver changed');
    body = body.replace(before, 'const usesEmbeddedModules = true;');
    changes.add('host-independent-extension-modules');
    const importing = '\tconst module = await jiti.import(extensionPath, { default: true });';
    if (!body.includes(importing)) throw new Error('Extension transform boundary changed');
    body = 'import { preparePluginTranspiler } from "../../../plugin-transpiler.ts";\n'
      + body.replace(importing, '\tpreparePluginTranspiler(jiti);\n' + importing);
    changes.add('preserve-host-stack-formatting-after-babel-bootstrap');
  }
  if (path === 'config.ts') {
    body = body.replace('export const VERSION: string = pkg.version || "0.0.0";',
      `export const VERSION: string = ${JSON.stringify(packageInfo.version)};`);
    body = body.replace('installed.version !== VERSION', 'installed.version !== pkg.version');
    changes.add('pinned-coding-version-with-host-install-detection');
    for (const segment of ['"modes", "interactive", "theme"', '"core", "export-html"', '"modes", "interactive", "assets"']) {
      const before = `join(packageDir, srcOrDist, ${segment})`;
      if (!body.includes(before)) throw new Error('Package asset resolver changed: ' + segment);
      body = body.replace(before, `join(packageDir, srcOrDist, "pi", ${segment})`);
    }
    changes.add('source-asset-location');
    body = portBundledAssets(body);
    changes.add('installed-native-bundle-assets');
  }
  if (path === 'core/footer-data-provider.ts' || path === 'core/resource-loader.ts' ||
      path === 'extensions/tool-search/tool.ts' || path === 'extensions/codemode/execute.ts' ||
      path === 'utils/zip.ts' || path === 'utils/tools-manager.ts' || path === 'utils/exif-orientation.ts' ||
      path === 'utils/image-resize-core.ts' || path === 'utils/mime.ts' || path === 'utils/ansi.ts' ||
      path === 'utils/child-process.ts' || path === 'utils/shell.ts' || path === 'core/tools/path-utils.ts' ||
      path === 'core/tools/truncate.ts' || path === 'core/tools/edit-diff.ts') {
    body = portSharedHelpers(path, body);
    changes.add(path === 'extensions/tool-search/tool.ts' ? 'shared-durable-tool-search-ranking'
      : path === 'extensions/codemode/execute.ts' ? 'shared-durable-codemode-executor'
      : path === 'utils/exif-orientation.ts' ? 'shared-durable-image-orientation'
      : path === 'utils/image-resize-core.ts' ? 'shared-durable-image-encoding'
      : path === 'utils/mime.ts' ? 'shared-durable-image-mime'
      : path === 'utils/ansi.ts' ? 'public-ansi-regex-complete-matcher'
      : path === 'utils/child-process.ts' ? 'shared-durable-child-process-wait'
      : path === 'utils/shell.ts' ? 'shared-durable-shell-algorithms'
      : path === 'core/tools/path-utils.ts' ? 'shared-durable-read-path-variants'
      : path === 'core/tools/truncate.ts' ? 'shared-durable-head-truncation'
      : path === 'core/tools/edit-diff.ts' ? 'shared-durable-edit-diff'
      : path === 'utils/zip.ts' ? 'public-fflate-zip-writer'
      : path === 'utils/tools-manager.ts' ? 'public-jszip-tool-archives' : 'shared-lightweight-resource-algorithms');
    if (path === 'extensions/tool-search/tool.ts' || path === 'extensions/codemode/execute.ts' ||
        path === 'utils/exif-orientation.ts' || path === 'utils/image-resize-core.ts' ||
        path === 'utils/mime.ts' || path === 'utils/child-process.ts' ||
        path === 'utils/shell.ts' || path === 'core/tools/path-utils.ts' ||
        path === 'core/tools/truncate.ts' || path === 'core/tools/edit-diff.ts') dependencies.add('@earendil-works/pi-durable');
    if (path === 'utils/zip.ts') dependencies.add('fflate');
    if (path === 'utils/tools-manager.ts') dependencies.add('jszip');
    if (path === 'utils/ansi.ts') dependencies.add('ansi-regex');
  }
  if (path === 'core/extensions/runner.ts' || path === 'core/session-manager.ts') {
    body = portCompatRuntime(path, body);
    changes.add('shared-legacy-runtime-policy');
  }
  const target = 'src/pi/' + path;
  save(target, body);
  records.push({ source: 'packages/coding-agent/src/' + path, target, sha256: hash(original), portSha256: hash(body), changes: [...changes] });
}

if (scoped) {
  const manifest = JSON.parse(readFileSync(join(destination, 'UPSTREAM-RUNTIME.json'), 'utf8'));
  for (const record of records) {
    const expected = manifest.files.find((entry: { target: string }) => entry.target === record.target);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(record)) throw new Error(`Scoped source record differs: ${record.target}`);
  }
  console.log(JSON.stringify({ mode: 'scoped-check', sourceFiles: records.length, complete: false }));
  process.exit(0);
}

function assets(directory: string) {
  for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) assets(path);
    else if (!path.endsWith('.ts')) {
      const body = readFileSync(join(source, path));
      const target = 'src/pi/' + path;
      save(target, body);
      records.push({ source: 'packages/coding-agent/src/' + path, target, sha256: hash(body), portSha256: hash(body), changes: [] });
    }
  }
}
for (const directory of ['modes/interactive/theme', 'modes/interactive/assets', 'core/export-html']) assets(directory);
// Reuse the public core state facade and protocol with a durable execution backend.
// The native agent-loop implementation is deliberately outside this source closure.
for (const [path, target] of [
  ['agent.ts', 'src/durable-agent.ts'],
  ['stream-fn.ts', 'src/stream-fn.ts'],
] as const) {
  const original = readFileSync(join(upstream, 'packages/agent/src', path), 'utf8');
  let body = original.replaceAll('"./types.ts"', '"./agent-runtime.ts"');
  const changes = ['local-agent-protocol'];
  if (path === 'agent.ts') {
    body = portAgentFacade(original);
    changes.push('public-core-agent-facade', 'durable-loop-backend', 'durable-state-recovery');
  }
  save(target, body);
  records.push({ source: 'packages/agent/src/' + path, target, sha256: hash(original), portSha256: hash(body), changes });
}
// These functions define request/message semantics, not scheduling. The durable task owns every transition.
const helperSource = readFileSync(join(upstream, 'packages/agent/src/agent-loop.ts'), 'utf8');
const helperAST = ts.createSourceFile('agent-loop.ts', helperSource, ts.ScriptTarget.Latest, true);
const helperNames = new Set([
  'declareToolChanges', 'withToolChanges', 'streamAssistantResponse', 'prepareToolCallArguments',
  'prepareToolCall', 'createErrorToolResult', 'emitToolExecutionEnd', 'createToolResultMessage',
  'emitToolResultMessage', 'shouldTerminateToolBatch',
]);
const functions = helperAST.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && !!node.name && helperNames.has(node.name.text));
if (functions.length !== helperNames.size) throw new Error('Pinned agent operation helpers changed');
const helperBody = [
  '// Native Pi request and tool preparation operations; scheduling belongs to pi-durable tasks.',
  'import { streamAssistantResponse as streamCoreResponse, type AgentEventSink } from "@earendil-works/pi-agent-core";',
  'import { PI_ATTRIBUTION, type AssistantMessage } from "@earendil-works/pi-ai";',
  'import type { AgentContext, AgentLoopConfig, StreamFn } from "./agent-runtime.ts";',
  'export type { AgentEventSink } from "@earendil-works/pi-agent-core";',
  '// Keep Native defaults separate from the mutable public core identity.',
  'export const DEFAULT_AGENT_IDENTITY = { attribution: PI_ATTRIBUTION };',
  'export {',
  ...functions.filter(node => node.name!.text !== 'streamAssistantResponse').map(node => '  ' + node.name!.text + ','),
  '} from "@earendil-works/pi-agent-core";',
  'export function streamAssistantResponse(',
  '  context: AgentContext, config: AgentLoopConfig, signal: AbortSignal | undefined,',
  '  emit: AgentEventSink, streamFunction: StreamFn,',
  '): Promise<AssistantMessage> {',
  '  return streamCoreResponse(context, config, signal, emit, streamFunction, DEFAULT_AGENT_IDENTITY);',
  '}',
  '',
].join('\n');
save('src/native-operations.ts', helperBody);
records.push({
  source: 'packages/agent/src/agent-loop.ts', target: 'src/native-operations.ts',
  sha256: hash(helperSource), portSha256: hash(helperBody), changes: ['public-core-operations-with-native-identity'],
});
// Clients need the exact native wire types without importing the coding implementation.
const rpcSource = readFileSync(join(source, 'modes/rpc/rpc-types.ts'), 'utf8');
const rpcAST = ts.createSourceFile('rpc-types.ts', rpcSource, ts.ScriptTarget.Latest, true);
const uiNames = new Set(['RpcExtensionUIRequest', 'RpcExtensionUIResponse']);
const uiDeclarations = rpcAST.statements.filter((node): node is ts.TypeAliasDeclaration =>
  ts.isTypeAliasDeclaration(node) && uiNames.has(node.name.text));
if (uiDeclarations.length !== uiNames.size) throw new Error('Pinned native UI wire types changed');
const inspectUIType = (node: ts.Node): void => {
  if (ts.isTypeReferenceNode(node)) throw new Error('Native UI wire types require an explicit dependency port');
  ts.forEachChild(node, inspectUIType);
};
uiDeclarations.forEach(inspectUIType);
const uiBody = '// Generated from Pi v1.5.0 (MIT); see LICENSE.pi and UPSTREAM-RUNTIME.json.\n'
  + uiDeclarations.map(node => node.getText(rpcAST)).join('\n\n') + '\n';
save('src/rpc-ui.ts', uiBody);
records.push({
  source: 'packages/coding-agent/src/modes/rpc/rpc-types.ts', target: 'src/rpc-ui.ts',
  sha256: hash(rpcSource), portSha256: hash(uiBody), changes: ['standalone-extension-ui-wire-contracts'],
});
const externalDependencies = Object.fromEntries([...dependencies].sort().map(name => {
  const version = packageInfo.dependencies[name] ?? localDependencies[name];
  return [name, version ?? '<builtin or development type>'];
}));
records.sort((a, b) => a.target.localeCompare(b.target));
const manifest = {
  repository: 'https://github.com/earendil-works/pi', version: '1.5.0', revision,
  policy: 'Complete public coding source, preserved TypeScript declarations; execution binds to the local durable Agent boundary.',
  dependencies: externalDependencies, coreImports: [...coreImports].sort(), files: records,
};
save('UPSTREAM-RUNTIME.json', JSON.stringify(manifest, null, 2) + '\n');
const sourceFiles = records.filter(record => record.target.endsWith('.ts')).length;
console.log(JSON.stringify({ mode: inventory ? 'inventory' : checking ? 'check' : 'write', sourceFiles, assets: records.length - sourceFiles, dependencies: externalDependencies, coreImports: [...coreImports].sort() }, null, 2));
