import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** Validate the shared, read-only input before any Craft comparison starts. */
export function requireCraftSource(repoRoot: string): { root: string; baseline: string } {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/craft-source-overrides.json'), 'utf8'))
  const expected: string = manifest.baselineCommit
  if (typeof expected !== 'string' || !/^[a-f0-9]{40}$/.test(expected)) {
    throw new Error('Invalid baselineCommit in scripts/craft-source-overrides.json')
  }

  const fail: (reason: string) => never = reason => {
    console.error(`Craft reference check failed: ${reason}`)
    console.error(`Prepare an independent checkout at baseline ${expected}.`)
    console.error('Set CRAFT_AGENT_SOURCE to its checkout root; see docs/upstream-sync.md.')
    process.exit(1)
  }

  const configured = process.env.CRAFT_AGENT_SOURCE
  if (configured === '') fail('CRAFT_AGENT_SOURCE is empty.')
  const candidates = [
    resolve(repoRoot, '..', 'craft-agents-oss'),
    resolve(repoRoot, '..', '..', 'agents', 'craft-agents-oss'),
  ]
  const root = configured === undefined ? candidates.find(candidate => existsSync(candidate)) : resolve(configured)
  if (!root || !existsSync(root)) fail('The Craft reference checkout is missing.')

  const checkout = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--show-toplevel'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (checkout.exitCode !== 0) fail('CRAFT_AGENT_SOURCE must point to a Git checkout.')
  const checkoutRoot = checkout.stdout.toString().replace(/\r?\n$/, '')
  if (realpathSync(root) !== realpathSync(checkoutRoot)) {
    fail('CRAFT_AGENT_SOURCE must point to the checkout root, not a nested directory.')
  }

  const revision = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (revision.exitCode !== 0) fail('The Craft checkout has no readable HEAD commit.')
  const baseline = revision.stdout.toString().trim()
  if (baseline !== expected) fail(`Craft baseline mismatch: expected ${expected}, found ${baseline}.`)

  const renderer = resolve(root, 'apps/electron/src/renderer')
  if (!existsSync(renderer) || !statSync(renderer).isDirectory()) {
    fail('The Craft checkout is incomplete: apps/electron/src/renderer is missing.')
  }
  return { root, baseline }
}
