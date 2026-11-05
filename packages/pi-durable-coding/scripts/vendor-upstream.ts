/** Reproduce the pinned Pi source port without importing the upstream package. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const revision = 'f9a26365568127461c47a07a37dcb42c140a3ac5';
const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: bun scripts/vendor-upstream.ts /absolute/pi-checkout [--check]');
const upstream = resolve(checkout);
const git = Bun.spawnSync(['git', '-C', upstream, 'rev-parse', 'HEAD']);
if (git.exitCode || git.stdout.toString().trim() !== revision) {
  throw new Error(`Expected Pi v1.5.0 at ${revision}`);
}
const dirty = Bun.spawnSync(['git', '-C', upstream, 'status', '--porcelain', '--', 'packages/coding-agent/src', 'packages/coding-agent/examples', 'packages/durable/src/harness/context.ts', 'LICENSE']);
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
    content = parsed.statements.filter(statement => {
      if (ts.isVariableStatement(statement)) {
        return !statement.declarationList.declarations.some(declaration =>
          ts.isIdentifier(declaration.name) && omitted.has(declaration.name.text));
      }
      return !(ts.isFunctionDeclaration(statement) && statement.name && omitted.has(statement.name.text));
    }).map(statement => statement.getFullText(parsed)).join('');
    content = 'import { createJiti } from "jiti/static";\n'
      + 'import { getExtensionModules } from "../../../extension-modules.ts";\n'
      + 'import { preparePluginTranspiler } from "../../../plugin-transpiler.ts";\n' + content;
    const originalResolution = /const resolutionOptions = usesEmbeddedModules[\s\S]*?: \{ alias: getAliases\(\) \};/;
    if (!originalResolution.test(content)) throw new Error('Upstream extension resolution changed');
    content = content.replace(originalResolution, 'const resolutionOptions = { virtualModules: getExtensionModules(), tryNative: false };')
      .replace('const createJitiImpl = await getCreateJiti();', 'const createJitiImpl = createJiti;');
    const importing = '\tconst module = await jiti.import(extensionPath, { default: true });';
    if (!content.includes(importing)) throw new Error('Upstream extension transform boundary changed');
    content = content.replace(importing, '\tpreparePluginTranspiler(jiti);\n' + importing);
    changes.push('preserve-host-stack-formatting-after-babel-bootstrap');
  }
  if (changes?.includes('headless-theme-binding')) {
    const originalImport = '"../../modes/interactive/theme/theme.ts"';
    if (!content.includes(originalImport)) throw new Error('Upstream runner theme import changed');
    content = content.replace(originalImport, '"../../../headless-ui.ts"');
  }
  if (changes?.includes('session-message-binding')) {
    content = content.replace('"./messages.ts"', '"./messages.js"');
  }
  if (changes?.includes('durable-model-projection')) {
    content = 'import { buildDurableContextEntries, finalizeDurableProjection } from "../../durable-projection.ts";\n' + content;
    const anchor = 'const messages = sessionEntryToContextMessages(entry);';
    if (content.split(anchor).length !== 2) throw new Error('Upstream context projection changed');
    content = content.replace(anchor,
      'const newerEdit = edit && (!("durableEntryOrder" in edit) || Number(edit.durableEntryOrder) > Number(entry.durableModelOrder));'
      + '\n\tconst messages = newerEdit && "durableBaseMessages" in entry ? entry.durableBaseMessages as AgentMessage[]'
      + ' : "durableModelMessages" in entry ? entry.durableModelMessages as AgentMessage[] : sessionEntryToContextMessages(entry);'
      + '\n\t// Persisted edits are already folded into the durable contribution. Preview edits still use Pi semantics.'
      + '\n\tif (edit && "durableModelOrder" in entry && "durableEntryOrder" in edit'
      + ' && Number(edit.durableEntryOrder) <= Number(entry.durableModelOrder)) return messages;');
    const selection = 'const path = buildSessionPath(entries, leafId, byId);\n\tlet compaction:';
    if (!content.includes(selection)) throw new Error('Upstream context selection changed');
    content = content.replace(selection, 'const path = buildSessionPath(entries, leafId, byId);\n'
      + '\tif (path.some(entry => "durableEntryOrder" in entry)) return buildDurableContextEntries(path);\n\tlet compaction:');
    const flattened = 'messages: projectedEntries.flatMap((entry) => entry.messages),';
    if (!content.includes(flattened)) throw new Error('Upstream projection finalization changed');
    content = content.replace(flattened, 'messages: finalizeDurableProjection(projectedEntries, path),');
  }
  const checkedIndexes: Record<string, Array<[string, string]>> = {
    'core/package-manager.ts': [
      ['const existing = currentPackages[matchIndex];', 'const existing = currentPackages[matchIndex]!;'],
      ['sources[0].source', 'sources[0]!.source'],
      ['await tasks[index]();', 'await tasks[index]!();'],
    ],
    'core/prompt-templates.ts': [['const char = argsString[i];', 'const char = argsString[i]!;']],
    'utils/paths.ts': [['match[1].toUpperCase()', 'match[1]!.toUpperCase()']],
  };
  if (checkedIndexes[source]) {
    // The upstream bounds and regular expressions establish these accesses; only TS strictness differs.
    for (const [before, after] of checkedIndexes[source]) {
      if (!content.includes(before)) throw new Error(`Checked index changed: ${source}: ${before}`);
      content = content.replaceAll(before, after);
    }
    changes = [...(changes ?? []), 'checked-index-access'];
  }
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

for (const file of [
  'core/skills.ts', 'core/prompt-templates.ts', 'core/source-info.ts', 'core/diagnostics.ts',
  'core/event-bus.ts', 'core/pi-manifest.ts', 'utils/frontmatter.ts', 'utils/text.ts',
  'utils/paths.ts', 'utils/child-process.ts',
  'core/package-manager.ts', 'utils/git.ts', 'core/output-guard.ts',
  'core/system-prompt.ts', 'core/exec.ts', 'core/timings.ts', 'core/mcp-servers.ts',
]) port(file);

port('core/extensions/runner.ts', 'core/extensions/runner.js', undefined, '', ['erase-types', 'headless-theme-binding']);
port('core/extensions/loader.ts', 'core/extensions/loader.js', undefined, '', ['erase-types', 'extension-module-resolution']);
port('core/extensions/types.ts', 'core/extensions/types.js', undefined, '', ['erase-types']);
port('core/extensions/pi-ai-extension-view.ts');
port('core/messages.ts', 'core/messages.js', undefined, '', ['erase-types']);
port('core/session-manager.ts', 'core/session-manager.js', undefined, '', ['erase-types', 'session-message-binding', 'durable-model-projection']);
port('core/model-registry.ts', 'core/model-registry.js', ['ModelRegistry'], '', ['erase-types']);
port('core/settings-manager.ts', 'core/settings-merge.js',
  ['isMergeableObject', 'deepMergeObjects', 'isToolModifier', 'mergeDefaultTools', 'deepMergeSettings'],
  'export { deepMergeSettings as mergeCodingSettings };\n', ['erase-types']);
port('core/provider-composer.ts', 'core/provider-composer.js', undefined, '', ['erase-types']);
port('core/resolve-config-value.ts', 'core/resolve-config-value.ts');
port('utils/shell.ts', 'utils/shell.ts', [
  'ShellConfig', 'isLegacyWslBashPath', 'getBashShellConfig', 'shellPathExists',
  'findExecutableOnPath', 'getShellConfig',
], 'import { accessSync, constants } from "node:fs";\n'
  + 'import { win32 } from "node:path";\nimport { spawnSync } from "node:child_process";\n\n');

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
  + 'import { findGitPaths } from "./git-paths.ts";\n\n');
port('core/resource-loader.ts', 'core/resource-collisions.ts', ['DefaultResourceLoader.dedupePrompts'],
  'import type { PromptTemplate } from "./prompt-templates.ts";\n'
  + 'import type { ResourceDiagnostic } from "./diagnostics.ts";\n\n');
port('core/compaction/compaction.ts', 'core/context-tokens.js', [
  'calculateContextTokens', 'getAssistantUsage', 'getLastAssistantUsageInfo',
  'estimateContextTokens', 'estimateProjectedContextTokens', 'ESTIMATED_IMAGE_CHARS',
  'estimateTextAndImageContentChars', 'estimateTokens',
], 'import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";\n\n', ['erase-types']);
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

save('LICENSE.pi', readFileSync(join(upstream, 'LICENSE'), 'utf8'));
save('UPSTREAM.json', JSON.stringify({
  repository: 'https://github.com/earendil-works/pi',
  version: '1.5.0', revision,
  policy: 'Source port. No pi-coding-agent or pi-agent-core package imports. Generated files are reproduced by scripts/vendor-upstream.ts.',
  typescript: ts.version,
  files: manifest,
}, null, 2) + '\n');
console.log(`${checking ? 'Verified' : 'Ported'} ${manifest.length} source files from Pi v1.5.0`);
