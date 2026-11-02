import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isPathInside, resolveInheritedAppEnv, sourceCheckoutRoot } from './inherited-app-env'

const own = '/work/CraftAgentsDev/sdk-uplift-release'
const app = '/work/CraftAgentsDev/craft-agents-design-remake'

describe('resolveInheritedAppEnv', () => {
  it("ignores a running app's MKAGENT_APP_ROOT and every MKAGENT_* path inside it", () => {
    const env = {
      MKAGENT_APP_ROOT: app,
      MKAGENT_RESOURCES_BASE: `${app}/apps/electron`,
      MKAGENT_UV: `${app}/apps/electron/resources/bin/darwin-arm64/uv`,
      MKAGENT_CLI_ENTRY: `${app}/packages/craft-cli/src/cli.ts`,
      MKAGENT_SESSION_DIR: '/work/CraftAgentWS/sessions/261010-onyx-heron',
      MKAGENT_CONFIG_DIR: '',
      MKAGENT_DEBUG: '1',
      PATH: `${app}/bin:/usr/bin`,
    }
    const result = resolveInheritedAppEnv(env, own, own)
    expect(result.ignoredAppRoot).toBe(app)
    expect(result.appRootPath).toBe(own)
    expect(result.dropKeys.sort()).toEqual(['MKAGENT_APP_ROOT', 'MKAGENT_CLI_ENTRY', 'MKAGENT_RESOURCES_BASE', 'MKAGENT_UV'])
  })

  it('falls back to the checkout root when the cwd is outside it', () => {
    expect(resolveInheritedAppEnv({ MKAGENT_APP_ROOT: app }, own, '/tmp').appRootPath).toBe(own)
  })

  it('keeps a MKAGENT_APP_ROOT inside its own checkout', () => {
    const result = resolveInheritedAppEnv({ MKAGENT_APP_ROOT: `${own}/apps/electron` }, own, own)
    expect(result).toEqual({ appRootPath: `${own}/apps/electron`, dropKeys: [] })
  })

  it('honors MKAGENT_APP_ROOT for bundled servers (no source checkout)', () => {
    expect(resolveInheritedAppEnv({ MKAGENT_APP_ROOT: '/app' }, null, '/srv')).toEqual({ appRootPath: '/app', dropKeys: [] })
  })

  it('defaults to the cwd when MKAGENT_APP_ROOT is unset', () => {
    expect(resolveInheritedAppEnv({}, own, own)).toEqual({ appRootPath: own, dropKeys: [] })
  })
})

describe('sourceCheckoutRoot', () => {
  it('keeps a real Bun bundle in packaged mode while its source checkout exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mkagent-runtime-bundle-'))
    try {
      const entry = join(root, 'entry.ts')
      const bundle = join(root, 'packaged', 'server.js')
      mkdirSync(join(root, 'packaged'), { recursive: true })
      const piServer = join(root, 'packaged', 'resources', 'pi-agent-server', 'index.js')
      mkdirSync(join(root, 'packaged', 'resources', 'pi-agent-server'), { recursive: true })
      writeFileSync(piServer, '// packaged fixture')
      writeFileSync(entry, `
        import { sourceCheckoutRoot } from ${JSON.stringify(join(import.meta.dir, 'inherited-app-env.ts'))};
        import { createHeadlessPlatform } from ${JSON.stringify(join(import.meta.dir, 'platform-headless.ts'))};
        import { resolveBackendRuntimePaths } from ${JSON.stringify(join(import.meta.dir, '../../../shared/src/agent/backend/internal/runtime-resolver.ts'))};
        const platform = createHeadlessPlatform();
        console.log(JSON.stringify({ source: sourceCheckoutRoot(), appRoot: platform.appRootPath,
          resources: platform.resourcesPath, packaged: platform.isPackaged,
          piServer: resolveBackendRuntimePaths(platform).piServerPath }));
      `)
      const build = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', outdir: join(root, 'packaged'), naming: 'server.js', external: ['sharp'] })
      expect(build.success, build.logs.map(String).join('\n')).toBe(true)
      const child = Bun.spawnSync([process.execPath, bundle], {
        cwd: tmpdir(),
        env: { ...process.env, MKAGENT_APP_ROOT: join(root, 'packaged'), MKAGENT_IS_PACKAGED: 'true',
          MKAGENT_RESOURCES_PATH: join(root, 'packaged', 'resources') },
      })
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      const result = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!)
      expect(result.source, JSON.stringify(result)).toBeNull()
      expect(result.appRoot).toBe(join(root, 'packaged'))
      expect(result.resources).toBe(join(root, 'packaged', 'resources'))
      expect(result.packaged).toBe(true)
      expect(result.piServer).toBe(piServer)
      rmSync(piServer)
      const missing = Bun.spawnSync([process.execPath, bundle], {
        cwd: tmpdir(),
        env: { ...process.env, MKAGENT_APP_ROOT: join(root, 'packaged'), MKAGENT_IS_PACKAGED: 'true' },
      })
      expect(missing.exitCode).toBe(0)
      expect(JSON.parse(missing.stdout.toString()).piServer).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds this monorepo when server-core runs from source', () => {
    const root = sourceCheckoutRoot()
    expect(root).not.toBeNull()
    expect(isPathInside(join(root!, 'packages', 'server-core'), root!)).toBe(true)
  })

  it('returns null outside a checkout (bundled builds) or without a module folder', () => {
    expect(sourceCheckoutRoot('/a/b/c/d')).toBeNull()
    expect(sourceCheckoutRoot(null)).toBeNull()
  })
})

describe('isPathInside', () => {
  it('treats a sibling with a shared prefix as outside', () => {
    expect(isPathInside('/work/repo-2/x', '/work/repo')).toBe(false)
    expect(isPathInside('/work/repo/x', '/work/repo')).toBe(true)
    expect(isPathInside('/work/repo', '/work/repo')).toBe(true)
  })
})
