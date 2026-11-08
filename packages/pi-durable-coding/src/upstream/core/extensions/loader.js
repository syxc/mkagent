// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
import { createExtensionRuntime, initializeExtension } from "../../../pi/core/extensions/loader.ts";
export { createExtensionRuntime, loadExtensionFromFactory } from "../../../pi/core/extensions/loader.ts";
import { createJiti } from "jiti/static";
import { getExtensionModules } from "../../../extension-modules.ts";
import { preparePluginTranspiler } from "../../../plugin-transpiler.ts";
/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { pathsEqual, resolvePath } from "../../utils/paths.ts";
import { createEventBus } from "../event-bus.ts";
import { readPiManifest } from "../pi-manifest.ts";
import { time } from "../timings.ts";
let extensionCacheCwd;
let extensionCacheGeneration = 0;
const extensionCache = new Map();
export function clearExtensionCache() {
    extensionCache.clear();
    extensionCacheCwd = undefined;
    extensionCacheGeneration++;
}
function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    if (extensionCacheCwd !== undefined && !pathsEqual(extensionCacheCwd, resolvedCwd)) {
        clearExtensionCache();
    }
    extensionCacheCwd = resolvedCwd;
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}
function isCurrentCacheToken(cacheToken) {
    return (cacheToken !== undefined &&
        extensionCacheCwd === cacheToken.cwd &&
        extensionCacheGeneration === cacheToken.generation);
}
async function loadExtensionModule(extensionPath, cacheToken) {
    if (isCurrentCacheToken(cacheToken)) {
        const cachedFactory = extensionCache.get(extensionPath);
        if (cachedFactory) {
            return cachedFactory;
        }
    }
    const createJitiImpl = createJiti;
    // Compiled binaries and the bundled Node distribution use embedded modules.
    // Source TypeScript reuses host modules and root tsconfig paths. Unbundled
    // Node builds use dist aliases and do not need the bundled virtual modules.
    const resolutionOptions = { virtualModules: getExtensionModules(), tryNative: false };
    const jiti = createJitiImpl(import.meta.url, {
        moduleCache: false,
        ...resolutionOptions,
    });
    preparePluginTranspiler(jiti);
    const module = await jiti.import(extensionPath, { default: true });
    const factory = module;
    if (typeof factory !== "function") {
        return undefined;
    }
    if (isCurrentCacheToken(cacheToken)) {
        extensionCache.set(extensionPath, factory);
    }
    return factory;
}
async function loadExtension(extensionPath, cwd, eventBus, runtime, cacheToken) {
    const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
    try {
        const factory = await loadExtensionModule(resolvedPath, cacheToken);
        time(`${extensionPath} module import`, "extensions");
        if (!factory) {
            return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
        }
        const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);
        return { extension, error: null };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { extension: null, error: `Failed to load extension: ${message}` };
    }
}
/**
 * Load extensions from paths.
 */
async function loadExtensionsInternal(paths, cwd, eventBus, runtime, useCache = false) {
    const extensions = [];
    const errors = [];
    const warnings = [];
    const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
    const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
    const resolvedEventBus = eventBus ?? createEventBus();
    const resolvedRuntime = runtime ?? createExtensionRuntime();
    for (const extPath of paths) {
        const { extension, error } = await loadExtension(extPath, resolvedCwd, resolvedEventBus, resolvedRuntime, cacheToken);
        if (error) {
            errors.push({ path: extPath, error });
            continue;
        }
        if (extension) {
            extensions.push(extension);
        }
    }
    return {
        extensions,
        errors,
        warnings,
        runtime: resolvedRuntime,
    };
}
export async function loadExtensions(paths, cwd, eventBus, runtime) {
    return loadExtensionsInternal(paths, cwd, eventBus, runtime);
}
export async function loadExtensionsCached(paths, cwd, eventBus, runtime) {
    return loadExtensionsInternal(paths, cwd, eventBus, runtime, true);
}
function isExtensionFile(name) {
    return name.endsWith(".ts") || name.endsWith(".js");
}
/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir) {
    // Check for package.json with "pi" field first
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        const manifest = readPiManifest(packageJsonPath);
        if (manifest?.extensions?.length) {
            const entries = [];
            for (const extPath of manifest.extensions) {
                const resolvedExtPath = path.resolve(dir, extPath);
                if (fs.existsSync(resolvedExtPath)) {
                    entries.push(resolvedExtPath);
                }
            }
            if (entries.length > 0) {
                return entries;
            }
        }
    }
    // Check for index.ts or index.js
    const indexTs = path.join(dir, "index.ts");
    const indexJs = path.join(dir, "index.js");
    if (fs.existsSync(indexTs)) {
        return [indexTs];
    }
    if (fs.existsSync(indexJs)) {
        return [indexJs];
    }
    return null;
}
/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const discovered = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            // 1. Direct files: *.ts or *.js
            if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
                discovered.push(entryPath);
                continue;
            }
            // 2 & 3. Subdirectories
            if (entry.isDirectory() || entry.isSymbolicLink()) {
                const entries = resolveExtensionEntries(entryPath);
                if (entries) {
                    discovered.push(...entries);
                }
            }
        }
    }
    catch {
        return [];
    }
    return discovered;
}
/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(configuredPaths, cwd, agentDir = getAgentDir(), eventBus) {
    const resolvedCwd = resolvePath(cwd);
    const resolvedAgentDir = resolvePath(agentDir);
    const allPaths = [];
    const seen = new Set();
    const addPaths = (paths) => {
        for (const p of paths) {
            const resolved = path.resolve(p);
            if (!seen.has(resolved)) {
                seen.add(resolved);
                allPaths.push(p);
            }
        }
    };
    // 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
    const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
    addPaths(discoverExtensionsInDir(localExtDir));
    // 2. Global extensions: agentDir/extensions/
    const globalExtDir = path.join(resolvedAgentDir, "extensions");
    addPaths(discoverExtensionsInDir(globalExtDir));
    // 3. Explicitly configured paths
    for (const p of configuredPaths) {
        const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            // Check for package.json with pi manifest or index.ts
            const entries = resolveExtensionEntries(resolved);
            if (entries) {
                addPaths(entries);
                continue;
            }
            // No explicit entries - discover individual files in directory
            addPaths(discoverExtensionsInDir(resolved));
            continue;
        }
        addPaths([resolved]);
    }
    return loadExtensions(allPaths, resolvedCwd, eventBus);
}
