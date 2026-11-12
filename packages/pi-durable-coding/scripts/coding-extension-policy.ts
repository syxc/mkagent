/** Bind host module import and discovery paths without replacing SDK lifecycle algorithms. */
export function codingExtensionPolicy(source: string, declarations: boolean): string {
  let body = source;
  const replace = (before: string, after: string, count = 1) => {
    if (body.split(before).length - 1 !== count) throw new Error('Published extension boundary changed: ' + before);
    body = body.replaceAll(before, after);
  };
  if (declarations) {
    replace('export declare function clearExtensionCache(): void;', `export interface ExtensionModuleOverrides {
    codingAgent?: unknown;
    agentCore?: unknown;
}
export declare function getExtensionModules(overrides?: ExtensionModuleOverrides): Promise<Record<string, unknown>>;
export interface ExtensionLoaderOptions {
    /** Stable importer identity isolates host factory caches. */
    importModule?: (extensionPath: string) => Promise<unknown>;
    modules?: () => ExtensionModuleOverrides | Promise<ExtensionModuleOverrides>;
    prepareImporter?: (importer: Pick<import("jiti").Jiti, "options">) => void;
    projectConfigDir?: string;
}
export declare function clearExtensionCache(options?: ExtensionLoaderOptions): void;`);
    replace('runtime?: ExtensionRuntime): Promise<LoadExtensionsResult>;',
      'runtime?: ExtensionRuntime, options?: ExtensionLoaderOptions): Promise<LoadExtensionsResult>;', 2);
    replace('agentDir?: string, eventBus?: EventBus): Promise<LoadExtensionsResult>;',
      'agentDir?: string, eventBus?: EventBus, options?: ExtensionLoaderOptions): Promise<LoadExtensionsResult>;');
    return body;
  }
  replace('let extensionCacheCwd;\nlet extensionCacheGeneration = 0;\nconst extensionCache = new Map();', `const extensionCaches = new WeakMap();
function getExtensionCache(options) {
    const importer = options?.importModule ?? options?.modules ?? getCreateJiti;
    let cache = extensionCaches.get(importer);
    if (!cache) {
        cache = { factories: new Map(), generation: 0, cwd: undefined };
        extensionCaches.set(importer, cache);
    }
    return cache;
}`);
  replace('export function clearExtensionCache() {',
    'export function clearExtensionCache(options) {\n    const cache = getExtensionCache(options);');
  replace('    extensionCache.clear();', '    cache.factories.clear();');
  replace('    extensionCacheCwd = undefined;', '    cache.cwd = undefined;');
  replace('    extensionCacheGeneration++;', '    cache.generation++;');
  replace('function useExtensionCacheCwd(cwd) {',
    'function useExtensionCacheCwd(cwd, options) {\n    const cache = getExtensionCache(options);');
  replace('extensionCacheCwd !== undefined && !pathsEqual(extensionCacheCwd, resolvedCwd)',
    'cache.cwd !== undefined && !pathsEqual(cache.cwd, resolvedCwd)');
  replace('        clearExtensionCache();', '        clearExtensionCache(options);');
  replace('    extensionCacheCwd = resolvedCwd;', '    cache.cwd = resolvedCwd;');
  replace('return { cwd: resolvedCwd, generation: extensionCacheGeneration };',
    'return { cwd: resolvedCwd, generation: cache.generation, cache };');
  replace('extensionCacheCwd === cacheToken.cwd', 'cacheToken.cache.cwd === cacheToken.cwd');
  replace('extensionCacheGeneration === cacheToken.generation', 'cacheToken.cache.generation === cacheToken.generation');
  replace('extensionCache.get(extensionPath)', 'cacheToken.cache.factories.get(extensionPath)');
  replace('extensionCache.set(extensionPath, factory)', 'cacheToken.cache.factories.set(extensionPath, factory)');
  replace('async function loadExtensionModule(extensionPath, cacheToken) {',
    'async function loadExtensionModule(extensionPath, cacheToken, options) {');
  const start = body.indexOf('    const createJitiImpl = await getCreateJiti();');
  const end = body.indexOf('    const factory = module;', start);
  if (start < 0 || end < 0) throw new Error('Published Jiti import boundary changed');
  let importing = body.slice(start, end).replace('    const module =', '    module =');
  const resolution = 'const resolutionOptions = usesEmbeddedModules';
  if (importing.split(resolution).length !== 2) throw new Error('Published importer resolution changed');
  importing = importing.replace(resolution, `const resolutionOptions = options?.modules
        ? { virtualModules: await getExtensionModules(await options.modules()), tryNative: false }
        : usesEmbeddedModules`);
  importing = importing.replace('    module = await jiti.import(',
    '    options?.prepareImporter?.(jiti);\n    module = await jiti.import(');
  body = body.slice(0, start) + `    let module;
    if (options?.importModule) {
        module = await options.importModule(extensionPath);
    } else {
${importing.split('\n').filter(Boolean).map(line => '    ' + line).join('\n')}
    }
` + body.slice(end);
  replace('async function loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken) {',
    'async function loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken, options) {');
  replace('await loadExtensionModule(resolvedPath, cacheToken)', 'await loadExtensionModule(resolvedPath, cacheToken, options)');
  replace('async function loadExtensionsInternal(paths, cwd, eventBus, runtime, useCache = false) {',
    'async function loadExtensionsInternal(paths, cwd, eventBus, runtime, useCache = false, options) {');
  replace('useCache ? useExtensionCacheCwd(cwd) : undefined', 'useCache ? useExtensionCacheCwd(cwd, options) : undefined');
  replace('await loadExtension(extPath, resolvedCwd, resolvedEventBus, resolvedRuntime, cacheToken)',
    'await loadExtension(extPath, resolvedCwd, resolvedEventBus, resolvedRuntime, cacheToken, options)');
  for (const name of ['loadExtensions', 'loadExtensionsCached']) {
    replace(`export async function ${name}(paths, cwd, eventBus, runtime) {`,
      `export async function ${name}(paths, cwd, eventBus, runtime, options) {`);
  }
  replace('return loadExtensionsInternal(paths, cwd, eventBus, runtime);',
    'return loadExtensionsInternal(paths, cwd, eventBus, runtime, false, options);');
  replace('return loadExtensionsInternal(paths, cwd, eventBus, runtime, true);',
    'return loadExtensionsInternal(paths, cwd, eventBus, runtime, true, options);');
  replace('agentDir = getAgentDir(), eventBus) {', 'agentDir = getAgentDir(), eventBus, options) {');
  replace('path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions")',
    'path.join(resolvedCwd, options?.projectConfigDir ?? CONFIG_DIR_NAME, "extensions")');
  replace('return loadExtensions(allPaths, resolvedCwd, eventBus);',
    'return loadExtensions(allPaths, resolvedCwd, eventBus, undefined, options);');
  return body + `
/** Keep SDK plugin modules and importer ownership while allowing a host execution backend. */
export async function getExtensionModules(overrides = {}) {
    const modules = { ...await getVirtualModules() };
    for (const namespace of ["@earendil-works", "@mariozechner"]) {
        if (overrides.codingAgent !== undefined) modules[namespace + "/pi-coding-agent"] = overrides.codingAgent;
        if (overrides.agentCore !== undefined) modules[namespace + "/pi-agent-core"] = overrides.agentCore;
    }
    return new Proxy(modules, {
        has(target, name) {
            if (overrides.agentCore !== undefined && typeof name === "string" && !Reflect.has(target, name)
                && /^@(earendil-works|mariozechner)\\/pi-(coding-agent|agent-core)\\//.test(name)) {
                throw new Error("Unsupported legacy runtime subpath: " + name);
            }
            return Reflect.has(target, name);
        },
    });
}
`;
}

/** Reuse pi-ai's schema construction at the SDK-owned TypeBox plugin boundary. */
export function codingExtensionViewPolicy(source: string): string {
  const before = 'import { Type } from "typebox";';
  const start = source.indexOf('    return Type.Unsafe({');
  const end = source.indexOf('    });', start);
  if (source.split(before).length !== 2 || start < 0 || end < 0) {
    throw new Error('Published plugin StringEnum boundary changed');
  }
  source = source.slice(0, start) + '    return Type.Unsafe(publicStringEnum(values, options));'
    + source.slice(end + '    });'.length);
  return source.replace(before, 'import { StringEnum as publicStringEnum } from "@earendil-works/pi-ai/compat";\n' + before);
}
