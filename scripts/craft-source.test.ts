import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const helper = join(import.meta.dir, 'craft-source.ts')
const roots: string[] = []
const entries = ['check-craft-ui-sync.ts', 'check-craft-test-coverage.ts', 'audit-craft-reuse.ts']

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mkagent-craft-check-'))
  roots.push(root)
  return root
}

function run(script: string, source?: string) {
  const env = { ...process.env }
  delete env.CRAFT_AGENT_SOURCE
  if (source !== undefined) env.CRAFT_AGENT_SOURCE = source
  const result = Bun.spawnSync([process.execPath, script], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' })
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

function probe(project: string, source?: string) {
  const script = join(fixture(), 'probe.ts')
  writeFileSync(script, `import { requireCraftSource } from ${JSON.stringify(helper)};\nconsole.log(JSON.stringify(requireCraftSource(${JSON.stringify(project)})));\n`)
  return run(script, source)
}

function project(root: string, baseline: string) {
  const path = join(root, 'project')
  mkdirSync(join(path, 'scripts'), { recursive: true })
  writeFileSync(join(path, 'scripts/craft-source-overrides.json'), JSON.stringify({ version: 2, baselineCommit: baseline }))
  return path
}

function reference(root: string) {
  const path = join(root, 'reference with spaces')
  const clone = Bun.spawnSync(['git', 'clone', '--shared', '--no-checkout', '--quiet', repo, path], { stdout: 'pipe', stderr: 'pipe' })
  expect(clone.exitCode).toBe(0)
  mkdirSync(join(path, 'apps/electron/src/renderer'), { recursive: true })
  const head = Bun.spawnSync(['git', '-C', path, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  expect(head.exitCode).toBe(0)
  return { path, head: head.stdout.toString().trim() }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Craft source preflight', () => {
  for (const entry of entries) {
    it(`preflight explains a missing reference for ${entry}`, () => {
      const result = run(join(import.meta.dir, entry), join(fixture(), 'absent'))
      expect(result.status).toBe(1)
      expect(result.output).toContain('CRAFT_AGENT_SOURCE')
      expect(result.output).toContain('docs/upstream-sync.md')
      expect(result.output).not.toContain('ENOENT')
      expect(result.output).not.toContain('fatal:')
    })
  }

  it('accepts a pinned Git checkout through an explicit path containing spaces', () => {
    const root = fixture()
    const ref = reference(root)
    const result = probe(project(root, ref.head), ref.path)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.output)).toEqual({ root: ref.path, baseline: ref.head })
  })

  it('finds the documented sibling checkout without an environment variable', () => {
    const root = fixture()
    const ref = reference(root)
    const source = join(root, 'craft-agents-oss')
    const clone = Bun.spawnSync(['git', 'clone', '--shared', '--no-checkout', '--quiet', ref.path, source], { stdout: 'pipe', stderr: 'pipe' })
    expect(clone.exitCode).toBe(0)
    mkdirSync(join(source, 'apps/electron/src/renderer'), { recursive: true })
    const result = probe(project(root, ref.head))
    expect(result.status).toBe(0)
    expect(JSON.parse(result.output).root).toBe(source)
  })

  it('rejects a different revision before comparing any files', () => {
    const root = fixture()
    const ref = reference(root)
    const result = probe(project(root, '0'.repeat(40)), ref.path)
    expect(result.status).toBe(1)
    expect(result.output).toContain('baseline mismatch')
    expect(result.output).toContain(ref.head)
    expect(result.output).toContain('0'.repeat(40))
  })

  it('rejects a nested directory that Git would resolve to an ancestor repository', () => {
    const root = fixture()
    const ref = reference(root)
    const nested = join(ref.path, 'nested')
    mkdirSync(join(nested, 'apps/electron/src/renderer'), { recursive: true })
    const result = probe(project(root, ref.head), nested)
    expect(result.status).toBe(1)
    expect(result.output).toContain('checkout root')
  })

  it('explains empty and non-Git source paths', () => {
    const root = fixture()
    const app = project(root, '0'.repeat(40))
    for (const source of ['', root]) {
      const result = probe(app, source)
      expect(result.status).toBe(1)
      expect(result.output).toContain('CRAFT_AGENT_SOURCE')
      expect(result.output).not.toContain('fatal:')
    }
  })
})
