/** Bind host discovery and cancellation without replacing SDK installation algorithms. */
const replace = (source: string, before: string, after: string): string => {
  if (source.split(before).length !== 2) throw new Error('Published tool manager boundary changed: ' + before);
  return source.replace(before, after);
};

export function codingManagementHttpPolicy(source: string, declaration: boolean): string {
  return declaration
    ? replace(source, 'export interface FetchRetryOptions {', 'export interface FetchRetryOptions {\n    fetch?: typeof fetch;')
    : replace(source, 'await fetch(input,', 'await (options.fetch ?? fetch)(input,');
}

export function codingToolsManagerPolicy(source: string, declaration: boolean): string {
  if (declaration) {
    source = replace(source, 'getLatestVersion(repo: string)', 'getLatestVersion(repo: string, signal?: AbortSignal)');
    source = replace(source, 'onStatus?: (status: ToolStatus) => void)', 'onStatus?: (status: ToolStatus) => void, signal?: AbortSignal)');
    return replace(source, '//# sourceMappingURL=',
      '/** Host installation policy; release selection, extraction and cleanup stay in the SDK. */\n'
      + 'export interface ToolManagerDependencies {\n'
      + '    getBinDir?: () => string;\n    version?: string;\n'
      + '    getToolPath?: (tool: "fd" | "rg") => string | null;\n'
      + '    platform?: () => NodeJS.Platform;\n    arch?: () => string;\n'
      + '    isOfflineModeEnabled?: () => boolean;\n    fetch?: typeof fetch;\n'
      + '    writeDownload?: (body: ReadableStream<Uint8Array>, destination: string, signal: AbortSignal) => Promise<void>;\n'
      + '    runCommand?: (command: string, args: string[]) => { status: number | null; error?: Error | null; stderr?: { toString(): string } | null; stdout?: { toString(): string } | null };\n'
      + '    extractZipArchive?: (archivePath: string, extractDir: string, assetName: string) => void | Promise<void>;\n}\n'
      + 'export declare function createToolManager(dependencies?: ToolManagerDependencies): {\n'
      + '    getToolPath: typeof getToolPath;\n    getLatestVersion: typeof getLatestVersion;\n    ensureTool: typeof ensureTool;\n};\n'
      + '//# sourceMappingURL=');
  }

  source = replace(source, 'const TOOLS_DIR = getBinDir();',
    'export function createToolManager(dependencies = {}) {\nconst TOOLS_DIR = (dependencies.getBinDir ?? getBinDir)();\n'
    + 'const runtimePlatform = dependencies.platform ?? platform;\nconst runtimeArch = dependencies.arch ?? arch;');
  source = source.replaceAll('platform()', 'runtimePlatform()').replaceAll('arch()', 'runtimeArch()');
  source = source.replaceAll('spawnSync(', '(dependencies.runCommand ?? spawnSync)(');
  source = replace(source, 'function isOfflineModeEnabled() {',
    'function isOfflineModeEnabled() {\n    if (dependencies.isOfflineModeEnabled) return dependencies.isOfflineModeEnabled();');
  for (const name of ['getToolPath', 'getLatestVersion', 'ensureTool']) {
    const prefix = name === 'getToolPath' ? '' : 'async ';
    source = replace(source, `export ${prefix}function ${name}(`, `${prefix}function ${name}(`);
  }
  source = replace(source, 'function getToolPath(tool) {',
    'function getToolPath(tool) {\n    if (dependencies.getToolPath) return dependencies.getToolPath(tool);');
  source = replace(source, 'getPiUserAgent(VERSION)', 'getPiUserAgent(dependencies.version ?? VERSION)');
  source = replace(source, 'async function getLatestVersion(repo) {', 'async function getLatestVersion(repo, signal) {');
  source = replace(source, '        redirect: "manual",', '        redirect: "manual",\n        signal,');
  source = replace(source, '{ timeoutMs: NETWORK_TIMEOUT_MS }', '{ timeoutMs: NETWORK_TIMEOUT_MS, fetch: dependencies.fetch }');
  source = replace(source, '    const location = response.status', '    signal?.throwIfAborted();\n    const location = response.status');
  source = replace(source, 'async function downloadFile(url, dest) {\n    const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });',
    'async function downloadFile(url, dest, signal) {\n'
    + '    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);\n'
    + '    const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;\n'
    + '    const response = await fetchWithRetry(url, { signal: lifetime }, { timeoutMs: DOWNLOAD_TIMEOUT_MS, fetch: dependencies.fetch });');
  source = replace(source, '    if (!response.ok) {', '    if (!response.ok) {\n        await response.body?.cancel().catch(() => {});');
  source = replace(source, '    const fileStream = createWriteStream(dest);\n    await pipeline(Readable.fromWeb(response.body), fileStream);',
    '    if (dependencies.writeDownload) {\n        await dependencies.writeDownload(response.body, dest, lifetime);\n    } else {\n'
    + '        const fileStream = createWriteStream(dest);\n'
    + '        await pipeline(Readable.fromWeb(response.body), fileStream, { signal: lifetime }).catch(error => { lifetime.throwIfAborted(); throw error; });\n'
    + '    }\n    lifetime.throwIfAborted();');
  source = replace(source, 'const systemRoot = process.env.SystemRoot;', 'const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;');
  source = replace(source, 'async function downloadTool(tool) {', 'async function downloadTool(tool, signal) {');
  source = replace(source, 'await getLatestVersion(config.repo);', 'await getLatestVersion(config.repo, signal);\n    signal?.throwIfAborted();');
  source = replace(source, '    const archivePath = join(TOOLS_DIR, assetName);\n', '');
  source = replace(source, '    // Download\n    await downloadFile(downloadUrl, archivePath);\n', '');
  source = replace(source, '    const extractDir = join(TOOLS_DIR,', '    const workDir = join(TOOLS_DIR,');
  source = replace(source, '    mkdirSync(extractDir, { recursive: true });\n    try {',
    '    const archivePath = join(workDir, assetName);\n    const extractDir = join(workDir, "contents");\n'
    + '    mkdirSync(extractDir, { recursive: true });\n    try {\n'
    + '        await downloadFile(downloadUrl, archivePath, signal);\n        signal?.throwIfAborted();');
  source = replace(source, '            extractZipArchive(archivePath, extractDir, assetName);',
    '            await (dependencies.extractZipArchive ?? extractZipArchive)(archivePath, extractDir, assetName);');
  source = replace(source, '            renameSync(extractedBinary, binaryPath);',
    '            signal?.throwIfAborted();\n            renameSync(extractedBinary, binaryPath);');
  source = replace(source, '        rmSync(archivePath, { force: true });\n        rmSync(extractDir, { recursive: true, force: true });',
    '        rmSync(workDir, { recursive: true, force: true });');
  source = replace(source, 'async function ensureTool(tool, onStatus) {',
    'async function ensureTool(tool, onStatus, signal) {\n    signal?.throwIfAborted();');
  source = replace(source, 'const path = await downloadTool(tool);', 'const path = await downloadTool(tool, signal);\n        signal?.throwIfAborted();');
  source = replace(source, '    catch (e) {', '    catch (e) {\n        signal?.throwIfAborted();');
  return replace(source, '//# sourceMappingURL=',
    'return { getToolPath, getLatestVersion, ensureTool };\n}\n'
    + 'export const { getToolPath, getLatestVersion, ensureTool } = createToolManager();\n//# sourceMappingURL=');
}
