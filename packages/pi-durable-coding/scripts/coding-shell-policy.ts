/** Bind host process policies without copying shell execution or presentation. */
import ts from 'typescript';

/** Keep discovery and PID tracking in the SDK, with one tracker per host binding. */
export function codingShellHelpersPolicy(source: string, declarations: boolean): string {
  const names = ['getShellConfig', 'getPowerShellConfig', 'getShellEnv',
    'trackDetachedChildPid', 'untrackDetachedChildPid', 'killTrackedDetachedChildren'];
  if (declarations) {
    const marker = '//# sourceMappingURL=';
    if (source.split(marker).length !== 2) throw new Error('Published shell declaration boundary changed');
    return source.replace(marker,
      'export interface ShellHelperDependencies {\n    getBinDir?: () => string;\n'
      + '    getBashShellConfig?: (shell: string) => ShellConfig;\n    killProcessTree?: typeof killProcessTree;\n}\n'
      + 'export interface ShellHelpers {\n' + names.map(name => `    ${name}: typeof ${name};\n`).join('')
      + '}\nexport declare function createShellHelpers(dependencies?: ShellHelperDependencies): ShellHelpers;\n' + marker);
  }
  const parsed = ts.createSourceFile('shell.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const remaining = new Set([...names, 'trackedDetachedChildPids']);
  const selected: Array<{ start: number; end: number; body: string }> = [];
  for (const node of parsed.statements) {
    const name = ts.isFunctionDeclaration(node) ? node.name?.text
      : ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
        && ts.isIdentifier(node.declarationList.declarations[0].name) ? node.declarationList.declarations[0].name.text : undefined;
    if (!name || !remaining.has(name)) continue;
    remaining.delete(name);
    let body = source.slice(node.getFullStart(), node.end);
    if (names.includes(name)) {
      if (!body.includes(`export function ${name}(`)) throw new Error('Published shell helper changed: ' + name);
      body = body.replace(`export function ${name}(`, `function ${name}(`);
    }
    const edit = (before: string, after: string, occurrences = 1) => {
      if (body.split(before).length !== occurrences + 1) throw new Error('Published shell helper policy changed: ' + name);
      body = body.replaceAll(before, after);
    };
    if (name === 'getShellConfig') edit('return getBashShellConfig(', 'return (dependencies.getBashShellConfig ?? getBashShellConfig)(', 5);
    if (name === 'getShellEnv') edit('const binDir = getBinDir();', 'const binDir = (dependencies.getBinDir ?? getBinDir)();');
    if (name === 'killTrackedDetachedChildren') edit('killProcessTree(pid);', '(dependencies.killProcessTree ?? killProcessTree)(pid);');
    selected.push({ start: node.getFullStart(), end: node.end, body });
  }
  if (remaining.size) throw new Error('Published shell helper declarations changed: ' + [...remaining].join(', '));
  let body = source;
  for (const node of [...selected].reverse()) body = body.slice(0, node.start) + body.slice(node.end);
  const marker = '//# sourceMappingURL=';
  if (body.split(marker).length !== 2) throw new Error('Published shell implementation boundary changed');
  return body.replace(marker, 'export function createShellHelpers(dependencies = {}) {'
    + selected.map(node => node.body).join('') + '\nreturn { ' + names.join(', ') + ' };\n}\n'
    + 'export const { ' + names.join(', ') + ' } = createShellHelpers();\n' + marker);
}

export function codingShellPolicy(source: string, declarations: boolean, powershell: boolean): string {
  let body = source;
  const edit = (before: string, after: string) => {
    if (body.split(before).length !== 2) throw new Error('Published shell boundary changed: ' + before);
    body = body.replace(before, after);
  };
  if (declarations) {
    if (powershell) {
      body = 'import type { ShellDependencies } from "./bash.ts";\n' + body;
      edit('createLocalPowerShellOperations()', 'createLocalPowerShellOperations(dependencies?: ShellDependencies)');
      for (const name of ['createPowerShellTool', 'createPowerShellToolDefinition']) {
        edit(`${name}(cwd: string, options?: PowerShellToolOptions)`, `${name}(cwd: string, options?: PowerShellToolOptions, dependencies?: ShellDependencies)`);
      }
    } else {
      body = 'import type * as shell from "../../utils/shell.ts";\n'
        + 'import type { waitForChildProcess } from "../../utils/child-process.ts";\n' + body;
      edit('/** Shared process execution used by the built-in shell tools. */', `/** Host policy bindings; omitted entries keep the SDK defaults. */
export interface ShellDependencies {
    getShellConfig?: typeof shell.getShellConfig;
    getPowerShellConfig?: typeof shell.getPowerShellConfig;
    getShellEnv?: typeof shell.getShellEnv;
    killProcessTree?: typeof shell.killProcessTree;
    trackDetachedChildPid?: typeof shell.trackDetachedChildPid;
    untrackDetachedChildPid?: typeof shell.untrackDetachedChildPid;
    waitForChildProcess?: typeof waitForChildProcess;
}
/** Shared process execution used by the built-in shell tools. */`);
      edit('resolveShellConfig: () => ShellConfig)', 'resolveShellConfig: () => ShellConfig, dependencies?: ShellDependencies)');
      edit('}): BashOperations;', '}, dependencies?: ShellDependencies): BashOperations;');
      edit('config: ShellToolConfig, options?: BashToolOptions)',
        'config: ShellToolConfig, options?: BashToolOptions, dependencies?: ShellDependencies, createOperations?: () => BashOperations)');
      for (const name of ['createBashTool', 'createBashToolDefinition']) {
        edit(`${name}(cwd: string, options?: BashToolOptions)`, `${name}(cwd: string, options?: BashToolOptions, dependencies?: ShellDependencies)`);
      }
    }
    return body;
  }
  if (powershell) {
    edit('export function createLocalPowerShellOperations()', 'export function createLocalPowerShellOperations(dependencies)');
    edit('createLocalShellOperations("PowerShell", getPowerShellConfig)',
      'createLocalShellOperations("PowerShell", dependencies?.getPowerShellConfig ?? getPowerShellConfig, dependencies)');
    edit(`createPowerShellToolDefinition(cwd, options) {
    return createShellToolDefinition(cwd, powershellToolConfig, {
        ...options,
        operations: options?.operations ?? createLocalPowerShellOperations(),
    });`, `createPowerShellToolDefinition(cwd, options, dependencies) {
    return createShellToolDefinition(cwd, powershellToolConfig, options, dependencies, () => createLocalPowerShellOperations(dependencies));`);
    edit('createPowerShellTool(cwd, options)', 'createPowerShellTool(cwd, options, dependencies)');
    edit('createPowerShellToolDefinition(cwd, options);', 'createPowerShellToolDefinition(cwd, options, dependencies);');
  } else {
    edit('createLocalShellOperations(shellName, resolveShellConfig)', 'createLocalShellOperations(shellName, resolveShellConfig, dependencies)');
    edit('env: env ?? getShellEnv(),', 'env: env ?? (dependencies?.getShellEnv ?? getShellEnv)(),');
    edit('                trackDetachedChildPid(child.pid);', '                (dependencies?.trackDetachedChildPid ?? trackDetachedChildPid)(child.pid);');
    // Both timeout and cancellation must use the same host process-tree policy.
    const kill = 'killProcessTree(child.pid);';
    if (body.split(kill).length !== 3) throw new Error('Published shell termination sites changed');
    body = body.replaceAll(kill, '(dependencies?.killProcessTree ?? killProcessTree)(child.pid);');
    edit('await waitForChildProcess(child)', 'await (dependencies?.waitForChildProcess ?? waitForChildProcess)(child)');
    edit('untrackDetachedChildPid(child.pid);', '(dependencies?.untrackDetachedChildPid ?? untrackDetachedChildPid)(child.pid);');
    edit('createLocalBashOperations(options)', 'createLocalBashOperations(options, dependencies)');
    edit('createLocalShellOperations("bash", () => getShellConfig(options?.shellPath))',
      'createLocalShellOperations("bash", () => (dependencies?.getShellConfig ?? getShellConfig)(options?.shellPath), dependencies)');
    edit('function resolveSpawnContext(command, cwd, spawnHook, exposeSessionEnvironment, ctx)',
      'function resolveSpawnContext(command, cwd, spawnHook, exposeSessionEnvironment, ctx, dependencies)');
    edit('const env = { ...getShellEnv() };', 'const env = { ...(dependencies?.getShellEnv ?? getShellEnv)() };');
    edit('createShellToolDefinition(cwd, config, options)', 'createShellToolDefinition(cwd, config, options, dependencies, createOperations)');
    edit('options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath })',
      'options?.operations ?? (createOperations ? createOperations() : createLocalBashOperations({ shellPath: options?.shellPath }, dependencies))');
    edit('exposeSessionEnvironment, ctx);', 'exposeSessionEnvironment, ctx, dependencies);');
    edit('export function createBashToolDefinition(cwd, options)', 'export function createBashToolDefinition(cwd, options, dependencies)');
    edit('createShellToolDefinition(cwd, bashToolConfig, options)', 'createShellToolDefinition(cwd, bashToolConfig, options, dependencies)');
    edit('createBashTool(cwd, options)', 'createBashTool(cwd, options, dependencies)');
    edit('createBashToolDefinition(cwd, options);', 'createBashToolDefinition(cwd, options, dependencies);');
  }
  return body;
}
