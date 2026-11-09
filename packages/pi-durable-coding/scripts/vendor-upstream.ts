/** Reproduce the pinned Pi source port without importing the upstream package. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { codingSDKImport } from './coding-sdk-imports.ts';

const revision = 'f9a26365568127461c47a07a37dcb42c140a3ac5';
const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: bun scripts/vendor-upstream.ts /absolute/pi-checkout [--check]');
const upstream = resolve(checkout);
const git = Bun.spawnSync(['git', '-C', upstream, 'rev-parse', 'HEAD']);
if (git.exitCode || git.stdout.toString().trim() !== revision) {
  throw new Error(`Expected Pi v1.5.0 at ${revision}`);
}
const dirty = Bun.spawnSync(['git', '-C', upstream, 'status', '--porcelain', '--', 'packages/coding-agent/src', 'packages/coding-agent/examples', 'packages/coding-agent/test/suite/mcp-oauth-server.ts', 'packages/durable/src/harness/context.ts', 'LICENSE']);
if (dirty.exitCode || dirty.stdout.toString().trim()) throw new Error('Upstream sources must be clean');
const destination = resolve(import.meta.dir, '..');
const sourceRoot = join(upstream, 'packages/coding-agent/src');
const checking = process.argv.includes('--check');
const manifest: Array<{ source: string; target: string; sha256: string; portSha256: string; selection?: string[]; changes?: string[] }> = [];

function save(path: string, content: string) {
  const target = join(destination, path);
  if (checking) {
    if (readFileSync(target, 'utf8') !== content) throw new Error(`Port differs: ${path}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function port(source: string, target = source, selection?: string[], imports = '', changes?: string[]) {
  const original = readFileSync(join(sourceRoot, source), 'utf8');
  let content = original;
  if (selection) {
    const parsed = ts.createSourceFile(source, original, ts.ScriptTarget.Latest, true);
    const remaining = new Set(selection);
    const statements: string[] = [];
    for (const statement of parsed.statements) {
      const declaration = ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        ? statement.declarationList.declarations[0] : undefined;
      const name = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text
        : 'name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)
        ? (statement.name as ts.Identifier).text : undefined;
      if (name && remaining.has(name)) {
        remaining.delete(name);
        statements.push(statement.getFullText(parsed).trim());
      }
      if (name && ts.isClassDeclaration(statement)) {
        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
          const selectionName = `${name}.${member.name.text}`;
          if (!remaining.has(selectionName)) continue;
          remaining.delete(selectionName);
          const declaration = ts.factory.createFunctionDeclaration(
            [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)], member.asteriskToken, member.name,
            member.typeParameters, member.parameters, member.type, member.body,
          );
          statements.push(ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, parsed));
        }
      }
    }
    if (remaining.size) throw new Error(`Missing ${source}: ${[...remaining].join(', ')}`);
    content = imports + statements.join('\n\n') + '\n';
  }
  if (changes?.includes('extension-module-resolution')) {
    const parsed = ts.createSourceFile(source, content, ts.ScriptTarget.Latest, true);
    const omitted = new Set(['require', 'isNodeSeaBinary', 'isTypeScriptSourceRuntime', 'usesEmbeddedModules',
      'createJitiPromise', 'virtualModulesPromise', '_aliases', 'getCreateJiti', 'getVirtualModules', 'getAliases']);
    const shared = new Map(['createExtensionRuntime', 'createExtensionAPI', 'createExtension',
      'initializeExtension', 'loadExtensionFromFactory'].map(name => [name, 0]));
    content = parsed.statements.filter(statement => {
      if (ts.isVariableStatement(statement)) {
        return !statement.declarationList.declarations.some(declaration =>
          ts.isIdentifier(declaration.name) && omitted.has(declaration.name.text));
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const name = statement.name.text;
        if (shared.has(name)) {
          shared.set(name, shared.get(name)! + 1);
          return false;
        }
        return !omitted.has(name);
      }
      return true;
    }).map(statement => statement.getFullText(parsed)).join('');
    for (const [name, count] of shared) if (count !== 1) throw new Error(`Expected one shared extension function: ${name}`);
    const lifecycle = '../../../pi/core/extensions/loader.ts';
    content = `import { createExtensionRuntime, initializeExtension } from "${lifecycle}";\n`
      + `export { createExtensionRuntime, loadExtensionFromFactory } from "${lifecycle}";\n`
      + 'import { createJiti } from "jiti/static";\n'
      + 'import { getExtensionModules } from "../../../extension-modules.ts";\n'
      + 'import { preparePluginTranspiler } from "../../../plugin-transpiler.ts";\n' + content;
    const originalResolution = /const resolutionOptions = usesEmbeddedModules[\s\S]*?: \{ alias: getAliases\(\) \};/;
    if (!originalResolution.test(content)) throw new Error('Upstream extension resolution changed');
    content = content.replace(originalResolution, 'const resolutionOptions = { virtualModules: getExtensionModules(), tryNative: false };')
      .replace('const createJitiImpl = await getCreateJiti();', 'const createJitiImpl = createJiti;');
    const importing = '\tconst module = await jiti.import(extensionPath, { default: true });';
    if (!content.includes(importing)) throw new Error('Upstream extension transform boundary changed');
    content = content.replace(importing, '\tpreparePluginTranspiler(jiti);\n' + importing);
    changes.push('preserve-host-stack-formatting-after-babel-bootstrap', 'shared-native-extension-lifecycle');
  }
  if (changes?.includes('host-project-context-trust')) {
    const signature = '\tagentDir: string;\n}';
    if (!content.includes(signature)) throw new Error('Project context signature changed');
    content = content.replace(signature, '\tagentDir: string;\n\tprojectTrusted?: boolean;\n}');
    const anchor = '\tconst ancestorContextFiles: Array<{ path: string; content: string }> = [];';
    if (!content.includes(anchor)) throw new Error('Project context trust boundary changed');
    content = content.replace(anchor, '\tif (options.projectTrusted === false) return contextFiles;\n\n' + anchor);
  }
  const parsed = ts.createSourceFile(target, content, ts.ScriptTarget.Latest, true);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const statement of parsed.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const sdk = codingSDKImport(target, statement.moduleSpecifier.text);
    if (sdk) replacements.push({ start: statement.moduleSpecifier.getStart(parsed), end: statement.moduleSpecifier.end, value: JSON.stringify(sdk) });
  }
  for (const replacement of replacements.reverse()) {
    content = content.slice(0, replacement.start) + replacement.value + content.slice(replacement.end);
  }
  if (replacements.length) changes = [...(changes ?? []), 'public-coding-sdk'];
  if (target.endsWith('.js')) {
    content = ts.transpileModule(content, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    } }).outputText;
  }
  content = `// Ported from Pi v1.5.0 (${revision}); MIT. See UPSTREAM.json and LICENSE.pi.\n` + content;
  save('src/upstream/' + target, content);
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  manifest.push({ source: join('packages/coding-agent/src', source), target: 'src/upstream/' + target,
    sha256: sha256(original), portSha256: sha256(content), ...(selection ? { selection } : {}), ...(changes ? { changes } : {}) });
}

// Host policies are authored once; generated compatibility paths only forward.
const legacyPolicies: Record<string, string> = {
  'core/package-manager.ts': 'src/legacy/package-manager.ts',
  'core/messages.js': 'src/legacy/messages.js',
  'core/model-registry.js': 'src/legacy/model-registry.js',
  'core/settings-merge.js': 'src/legacy/settings-merge.js',
  'core/context-tokens.js': 'src/legacy/context-tokens.js',
  'core/extensions/runner.js': 'src/legacy/extension-runner.js',
  'core/session-manager.js': 'src/legacy/session-manager.js',
};

// These public helpers need one implementation, including when old entry points import them.
const forwarded = [
  'core/source-info.ts', 'core/pi-manifest.ts',
  'utils/text.ts', 'utils/paths.ts',
  'utils/child-process.ts',
  'core/exec.ts', 'core/timings.ts', 'core/mcp-servers.ts',
  'core/skills.ts', 'core/prompt-templates.ts', 'core/system-prompt.ts',
  'core/extensions/types.js', 'core/extensions/pi-ai-extension-view.ts',
  'core/provider-composer.js', 'core/resolve-config-value.ts', 'utils/shell.ts',
  'core/package-manager.ts', 'core/messages.js', 'core/model-registry.js', 'core/settings-merge.js',
  'core/context-tokens.js', 'core/extensions/runner.js', 'core/session-manager.js',
].map(file => ({
  target: 'src/upstream/' + file,
  implementation: legacyPolicies[file] ?? 'src/pi/' + file.replace(/\.js$/, '.ts'),
  ...(file === 'core/skills.ts' ? { changes: ['explicit-host-agent-directory', 'explicit-host-project-resource-directory'] }
    : file === 'core/prompt-templates.ts' ? { changes: ['explicit-host-project-resource-directory'] }
    : file === 'core/system-prompt.ts' ? { changes: ['host-documentation-paths'] }
    : file === 'utils/shell.ts' ? { changes: ['selected-public-shell-api'] }
    : file === 'core/package-manager.ts' ? { changes: ['legacy-project-directory-and-offline-policy'] }
    : file === 'core/messages.js' ? { changes: ['legacy-message-metadata-and-identity'] }
    : file === 'core/model-registry.js' ? { changes: ['structural-model-runtime-constructor'] }
    : file === 'core/settings-merge.js' ? { changes: ['legacy-open-settings-shape'] }
    : file === 'core/context-tokens.js' ? { changes: ['legacy-open-token-inputs'] }
    : file === 'core/extensions/runner.js' ? { changes: ['legacy-headless-theme-and-system-prompt'] }
    : file === 'core/session-manager.js' ? { changes: ['legacy-durable-projection-and-storage-factories'] } : {}),
}));
for (const item of forwarded) {
  const file = item.target.slice('src/upstream/'.length);
  const path = file.replace(/\.js$/, '.ts');
  const specifier = JSON.stringify(relative(dirname(item.target), item.implementation).split(sep).join('/'));
  let content = (legacyPolicies[file]
    ? '// Shared host compatibility policy; generated by vendor-upstream.ts.\n'
    : '// Shared native implementation; keep legacy imports without another source copy.\n')
    + (path === 'utils/shell.ts' ? `export { getShellConfig, type ShellConfig } from ${specifier};\n`
      : `export * from ${specifier};\n`);
  if (path === 'core/skills.ts') {
    content += 'import { loadSkills as loadNativeSkills, type LoadSkillsOptions } from "../../pi/core/skills.ts";\n'
      + 'import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";\n\n'
      + 'export function loadSkills(options: LoadSkillsOptions) {\n'
      + '  return loadNativeSkills({ ...options, agentDir: options.agentDir ?? getAgentDir() }, CONFIG_DIR_NAME);\n'
      + '}\n';
  }
  if (path === 'core/prompt-templates.ts') {
    content += 'import { loadPromptTemplates as loadNativePromptTemplates, type LoadPromptTemplatesOptions } from "../../pi/core/prompt-templates.ts";\n'
      + 'import { CONFIG_DIR_NAME } from "../config.ts";\n\n'
      + 'export function loadPromptTemplates(options: LoadPromptTemplatesOptions) {\n'
      + '  return loadNativePromptTemplates(options, CONFIG_DIR_NAME);\n'
      + '}\n';
  }
  if (path === 'core/system-prompt.ts') {
    content += 'export { buildSystemPrompt, buildSystemPromptSections, buildSystemPromptState } from "../../host-system-prompt.ts";\n';
  }
  save(item.target, content);
}

port('core/extensions/loader.ts', 'core/extensions/loader.js', undefined, '', ['erase-types', 'extension-module-resolution']);

port('core/footer-data-provider.ts', 'core/git-paths.ts', ['GitPaths', 'findGitPaths'],
  'import { existsSync, readFileSync, statSync } from "node:fs";\n'
  + 'import { dirname, join, resolve } from "node:path";\n\n');
port('core/resource-loader.ts', 'core/context-files.ts',
  ['loadContextFileFromDir', 'findShadowedContextFile', 'loadProjectContextFiles'],
  'import { existsSync, readFileSync, statSync } from "node:fs";\n'
  + 'import { basename, dirname, join } from "node:path";\n'
  + 'import chalk from "chalk";\n'
  + 'import { canonicalizePath, isPathWithin, pathsEqual, resolvePath } from "../utils/paths.ts";\n'
  + 'import { stripBom } from "../utils/text.ts";\n'
  + 'import { findGitPaths } from "./git-paths.ts";\n\n'
  + 'export { loadContextFileFromDir, findShadowedContextFile };\n\n', ['host-project-context-trust']);
port('core/resource-loader.ts', 'core/resource-collisions.ts', ['DefaultResourceLoader.dedupePrompts'],
  'import type { PromptTemplate } from "./prompt-templates.ts";\n'
  + 'import type { ResourceDiagnostic } from "./diagnostics.ts";\n\n');
port('core/agent-session.ts', 'core/boundary-drafts.js', [
  'AgentSession._applyBoundaryDrafts', 'AgentSession._buildBoundaryContext', 'AgentSession._replaceMessageInPlace',
], 'import { estimateProjectedContextTokens } from "./context-tokens.js";\n'
  + 'import { convertToLlm } from "./messages.js";\n\n', ['erase-types']);

port('../../durable/src/harness/context.ts', 'durable/context.js', [
  'EXCLUDED_STOP_REASONS', 'MISSING_RESULT_TEXT', 'findBaseline', 'carriesSystemMessage',
  'leadWithSystem', 'contribute', 'orderToolResults', 'missingResult', 'deeplyFrozen', 'freezeJson',
], 'import { SystemEntry } from "@earendil-works/pi-durable";\n'
  + 'export { findBaseline, leadWithSystem, contribute };\n\n', ['erase-types']);

// Keep official fixtures byte-for-byte so compatibility tests exercise real imports.
for (const name of ['hello.ts', 'input-transform.ts', 'rpc-demo.ts', 'confirm-destructive.ts', 'session-name.ts']) {
  const source = `packages/coding-agent/examples/extensions/${name}`;
  const target = `test/fixtures/upstream/${name}`;
  const content = readFileSync(join(upstream, source), 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  save(target, content);
  manifest.push({ source, target, sha256, portSha256: sha256 });
}

{
  const source = 'packages/coding-agent/test/suite/mcp-oauth-server.ts';
  const target = 'test/fixtures/upstream/mcp-oauth-server.ts';
  const content = readFileSync(join(upstream, source), 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  save(target, content);
  manifest.push({ source, target, sha256, portSha256: sha256 });
}

save('LICENSE.pi', readFileSync(join(upstream, 'LICENSE'), 'utf8'));
save('UPSTREAM.json', JSON.stringify({
  repository: 'https://github.com/earendil-works/pi',
  version: '1.5.0', revision,
  policy: 'Selected source adapters and forwards. Complete published Coding SDK contracts use @earendil-works/pi-coding-agent instead of local source. Reproduced by scripts/vendor-upstream.ts.',
  typescript: ts.version,
  files: manifest,
  forwarded,
}, null, 2) + '\n');
console.log(`${checking ? 'Verified' : 'Ported'} ${manifest.length} source files and ${forwarded.length} shared forwards from Pi v1.5.0`);
