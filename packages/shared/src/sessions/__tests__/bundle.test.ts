import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, renameSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { serializeSession, validateBundle, MAX_BUNDLE_SIZE_BYTES } from '../bundle'
import { writeSessionJsonl } from '../jsonl'
import type { StoredSession, SessionHeader } from '../types'
import { collectDurableBundle } from '../durable-bundle'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openDurableStorage } from '../../../../pi-agent-server/src/storage/durable-storage.ts'

// ============================================================
// Helpers
// ============================================================

function makeTmpDir(): string {
  const dir = join(tmpdir(), `bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStoredSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: '260101-test-session',
    workspaceRootPath: '/tmp/ws',
    createdAt: 1000,
    lastUsedAt: 2000,
    name: 'Test Session',
    messages: [
      {
        id: 'msg-1',
        type: 'user',
        content: 'Hello world',
        timestamp: 1000,
      },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'Hi there!',
        timestamp: 1500,
      },
    ],
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      contextTokens: 100,
      costUsd: 0.001,
    },
    ...overrides,
  } as StoredSession
}

function setupSessionDir(workspaceRoot: string, session: StoredSession): string {
  const sessionsDir = join(workspaceRoot, 'sessions', session.id)
  mkdirSync(sessionsDir, { recursive: true })

  // Write JSONL
  const jsonlPath = join(sessionsDir, 'session.jsonl')
  writeSessionJsonl(jsonlPath, session)

  return sessionsDir
}

async function setupDurableStore(storeDir: string, backend: 'jsonl' | 'sqlite', marker: string): Promise<void> {
  const storage = await (backend === 'jsonl'
    ? openNodeJsonlStorage(storeDir, BACKGROUND_CONTEXT)
    : openDurableStorage(storeDir, BACKGROUND_CONTEXT))
  const harness = await Harness.open(storage, {
    models: () => { throw new Error('Model access is not expected in bundle fixtures') },
    registry: createRegistry(),
  }, BACKGROUND_CONTEXT)
  try {
    const root = await harness.root(BACKGROUND_CONTEXT)
    await root.commit(tx => tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: marker, timestamp: 1 }] }), BACKGROUND_CONTEXT)
  } finally {
    await harness.close(BACKGROUND_CONTEXT)
  }
}

// ============================================================
// Tests
// ============================================================

describe('serializeSession', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('produces a valid bundle from a session directory', () => {
    const session = makeStoredSession()
    setupSessionDir(tmpDir, session)

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.version).toBe(1)
    expect(bundle!.session.header.id).toBe(session.id)
    expect(bundle!.session.messages).toHaveLength(2)
    expect(bundle!.session.messages[0]!.content).toBe('Hello world')
    expect(bundle!.session.messages[1]!.content).toBe('Hi there!')
    expect(Array.isArray(bundle!.files)).toBe(true)
  })

  for (const file of ['store.db', 'main.jsonl']) {
    it(`does not export unredacted durable history from ${file}`, () => {
      const session = makeStoredSession()
      const sessionDir = setupSessionDir(tmpDir, session)
      const storeDir = join(sessionDir, 'durable-store')
      mkdirSync(storeDir)
      writeFileSync(join(storeDir, file), 'unredacted durable history')
      expect(serializeSession(tmpDir, session.id)).toBeNull()
    })
  }

  for (const backend of ['jsonl', 'sqlite'] as const) {
    it(`rejects a durable-store root symlink to an external ${backend} store`, async () => {
      const session = makeStoredSession()
      const sessionDir = setupSessionDir(tmpDir, session)
      const external = join(tmpDir, 'external-store')
      const marker = `external-${backend}-history-marker`
      await setupDurableStore(external, backend, marker)
      // Prove the target is valid and exportable before testing the forbidden alias.
      const ordinary = collectDurableBundle(external)
      expect(ordinary.some(file => Buffer.from(file.contentBase64, 'base64').includes(marker))).toBe(true)
      const before = Object.fromEntries(readdirSync(external).map(name => [name, readFileSync(join(external, name))]))
      const storeDir = join(sessionDir, 'durable-store')
      symlinkSync(external, storeDir, 'dir')

      expect(serializeSession(tmpDir, session.id)).toBeNull()
      expect(() => collectDurableBundle(storeDir)).toThrow()
      expect(Object.fromEntries(readdirSync(external).map(name => [name, readFileSync(join(external, name))]))).toEqual(before)
    })

    for (const dangling of [false, true]) {
      it(`rejects an internal ${dangling ? 'dangling ' : ''}symlink in a durable ${backend} store`, async () => {
        const session = makeStoredSession()
        const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
        const marker = `ordinary-${backend}-history-marker`
        await setupDurableStore(storeDir, backend, marker)
        expect(serializeSession(tmpDir, session.id)).not.toBeNull()
        const name = backend === 'jsonl' ? 'main.jsonl' : 'store.db'
        const external = join(tmpDir, name)
        renameSync(join(storeDir, name), external)
        symlinkSync(dangling ? join(tmpDir, 'missing-file') : external, join(storeDir, name), 'file')

        expect(serializeSession(tmpDir, session.id)).toBeNull()
        expect(() => collectDurableBundle(storeDir)).toThrow()
      })
    }
  }

  it('rejects a dangling durable-store root symlink instead of exporting partial history', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    symlinkSync(join(tmpDir, 'missing-store'), storeDir, 'dir')
    expect(existsSync(storeDir)).toBe(false)

    expect(serializeSession(tmpDir, session.id)).toBeNull()
    expect(() => collectDurableBundle(storeDir)).toThrow()
  })

  it('rejects a non-directory durable-store root', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    writeFileSync(storeDir, 'not a durable directory')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
    expect(() => collectDurableBundle(storeDir)).toThrow()
  })

  it('exports an ordinary legacy session without a durable-store root', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    mkdirSync(join(sessionDir, '.pi-sessions'))
    writeFileSync(join(sessionDir, '.pi-sessions', 'legacy.jsonl'), JSON.stringify({ type: 'session', id: 'legacy-session', version: 3 }) + '\n')
    writeFileSync(join(sessionDir, 'notes.md'), 'legacy attachment')

    const bundle = serializeSession(tmpDir, session.id)
    expect(bundle).not.toBeNull()
    expect(bundle!.session.messages).toEqual(session.messages)
    expect(bundle!.files.map(file => file.relativePath)).toEqual(['notes.md'])
  })

  it('includes attachment files in bundle', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    // Create an attachment
    const attachDir = join(sessionDir, 'attachments')
    mkdirSync(attachDir, { recursive: true })
    writeFileSync(join(attachDir, 'screenshot.png'), Buffer.from('fake-png-data'))

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.files).toHaveLength(1)
    expect(bundle!.files[0]!.relativePath).toBe(join('attachments', 'screenshot.png'))
    expect(bundle!.files[0]!.size).toBe(13) // 'fake-png-data'.length
    // Verify base64 round-trips correctly
    const decoded = Buffer.from(bundle!.files[0]!.contentBase64, 'base64').toString()
    expect(decoded).toBe('fake-png-data')
  })

  it('includes attachments in a nested durable-store directory', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const attachmentDir = join(sessionDir, 'attachments', 'durable-store')
    mkdirSync(attachmentDir, { recursive: true })
    writeFileSync(join(attachmentDir, 'note.txt'), 'attachment')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle?.files.map(file => file.relativePath)).toContain('attachments/durable-store/note.txt')
  })

  for (const [command, output, secret] of [
    ['fill @e2 fake-secret', 'Filled element @e2 (11 characters)\nActive element after: unknown', 'fake-secret'],
    ['type fake-secret', 'Typed 11 characters into focused element\nActive element after: unknown', 'fake-secret'],
    ['paste fake-secret', 'Pasted 11 characters\nShortcut used: Cmd+V', 'fake-secret'],
    ['fill @e2 fake-secret', 'Error: input could not finish', 'fake-secret'],
    ['paste fake-secret2; fill @e2 ordinary', 'Pasted 12 characters\nShortcut used: Cmd+V\nFilled element @e2 with "ordinary"', 'fake-secret2'],
  ]) {
    it(`redacts older ${command!.split(' ')[0]} history when the field type was not reported`, () => {
      const session = makeStoredSession()
      const sessionDir = setupSessionDir(tmpDir, session)
      const storeDir = join(sessionDir, 'durable-store')
      mkdirSync(storeDir)
      const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command } }
      const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: output }], ...(output!.startsWith('Error:') ? { isError: true } : {}) }
      writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

      const bundle = serializeSession(tmpDir, session.id)
      if (output!.includes('with "ordinary"')) {
        expect(bundle).toBeNull()
      } else {
        expect(bundle).not.toBeNull()
        const contents = bundle!.files.map(file => Buffer.from(file.contentBase64, 'base64').toString()).join('')
        expect(contents).not.toContain(secret!)
      }
    })
  }

  it('redacts a legacy input whose final focus cannot prove its target', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: 'type fixture-secret' } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Typed 14 characters into focused element\nActive element after: input' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    const bundle = serializeSession(tmpDir, session.id)
    expect(bundle).not.toBeNull()
    const contents = bundle!.files.map(file => Buffer.from(file.contentBase64, 'base64').toString()).join('')
    expect(contents).not.toContain('fixture-secret')
  })

  it('rejects a short password that appears in retained session content', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', 'h'] } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('preserves unrelated placeholder text in a batch containing a password', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const command = 'fill @e2 unrelated-secret-123; click "[password: 2 characters]"'
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    const bundle = serializeSession(tmpDir, session.id)
    expect(bundle).not.toBeNull()
    const contents = Buffer.from(bundle!.files.find(file => file.relativePath === 'durable-store/main.jsonl')!.contentBase64, 'base64').toString()
    expect(contents).toContain('fill @e2 ; click \\\"[password: 2 characters]\\\"')
  })

  it.each([
    { command: ['fill', '@e2', '[password: 2 characters]'] },
    { command: 'fill @e2 "[password: 2 characters]"' },
  ])('rejects a password shaped like a redaction placeholder', ({ command }) => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result, copy: '[password: 2 characters]' }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects a known browser password in other exported session content', () => {
    const secret = 'export-test-password-9w7q'
    const session = makeStoredSession({ name: secret })
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', secret] } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  for (const location of ['message', 'attachment content', 'attachment path', 'durable metadata'] as const) {
    it(`rejects a known browser password in ${location}`, () => {
      const secret = 'fake-browser-secret-in-export'
      const session = makeStoredSession(location === 'message' ? {
        messages: [{ id: 'msg-secret', type: 'user', content: secret, timestamp: 1000 }],
      } : {})
      const sessionDir = setupSessionDir(tmpDir, session)
      const storeDir = join(sessionDir, 'durable-store')
      mkdirSync(storeDir)
      const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', secret] } }
      const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
      writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')
      if (location === 'attachment content') writeFileSync(join(sessionDir, 'copy.txt'), secret)
      if (location === 'attachment path') writeFileSync(join(sessionDir, `${secret}.txt`), 'ordinary content')
      if (location === 'durable metadata') writeFileSync(join(storeDir, 'id-map.json'), JSON.stringify({ value: secret }))

      expect(serializeSession(tmpDir, session.id)).toBeNull()
    })
  }

  it('exports and re-exports a placeholder-shaped password without retaining it', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: 'fill @e2 "[password: 2 characters]"' } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    for (let i = 0; i < 2; i++) {
      const bundle = serializeSession(tmpDir, session.id)
      expect(bundle).not.toBeNull()
      const contents = Buffer.from(bundle!.files.find(file => file.relativePath === 'durable-store/main.jsonl')!.contentBase64, 'base64').toString()
      expect(contents).not.toContain('[password: 2 characters]')
      writeFileSync(join(storeDir, 'main.jsonl'), contents)
    }
  })

  it('never regenerates a password-shaped placeholder across repeated exports', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    mkdirSync(storeDir)
    const secret = '[password: 25 characters]'
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', secret] } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    for (let i = 0; i < 6; i++) {
      const bundle = serializeSession(tmpDir, session.id)
      expect(bundle).not.toBeNull()
      const contents = Buffer.from(bundle!.files.find(file => file.relativePath === 'durable-store/main.jsonl')!.contentBase64, 'base64').toString()
      expect(contents).not.toContain(secret)
      writeFileSync(join(storeDir, 'main.jsonl'), contents)
    }
  })

  it('rejects copies when a placeholder-shaped password matches its generated placeholder', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    mkdirSync(storeDir)
    const secret = '[password: 25 characters]'
    expect(secret.length).toBe(25)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: `fill @e2 ${secret}` } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result, copy: secret }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects a short password that also appears in a dynamic key', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', 'h'] } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result, data: { h: 'copy' } }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('preserves an ordinary browser call that matches a separate password fill', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    mkdirSync(storeDir)
    const command = 'fill @e2 input-in-two-fields'
    const passwordCall = { type: 'toolCall', id: 'password', name: 'browser_tool', arguments: { command } }
    const passwordResult = { role: 'toolResult', toolCallId: 'password', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    const ordinaryCall = { type: 'toolCall', id: 'ordinary', name: 'browser_tool', arguments: { command } }
    const ordinaryResult = { role: 'toolResult', toolCallId: 'ordinary', toolName: 'browser_tool', content: [{ type: 'text', text: 'ordinary input filled' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', passwordCall, passwordResult, ordinaryCall, ordinaryResult }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('preserves a non-browser command that matches a browser password fill', () => {
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    mkdirSync(storeDir)
    const command = 'fill @e2 ordinary-then-secret'
    const passwordCall = { type: 'toolCall', id: 'browser', name: 'browser_tool', arguments: { command } }
    const result = { role: 'toolResult', toolCallId: 'browser', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    const otherCall = { type: 'toolCall', id: 'shell', name: 'bash', arguments: { command } }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', passwordCall, result, otherCall }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects an attachment containing a password joined from array-mode arguments', () => {
    const words = ['arrayalpha', 'betavalue']
    const secret = words.join(' ')
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', ...words] } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')
    writeFileSync(join(sessionDir, 'copy.txt'), secret)

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('exports array-mode passwords with their complete value removed', () => {
    const words = ['arrayalpha', 'betavalue']
    const secret = words.join(' ')
    const session = makeStoredSession()
    const storeDir = join(setupSessionDir(tmpDir, session), 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', ...words] } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    const bundle = serializeSession(tmpDir, session.id)
    expect(bundle).not.toBeNull()
    const text = Buffer.from(bundle!.files[0]!.contentBase64, 'base64').toString()
    expect(text).not.toContain(secret)
    for (const word of words) expect(text).not.toContain(word)
  })

  it('rejects a password also present in the retained browser command', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: ['fill', '@e2', '@e2'] } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2 (3 characters)' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('redacts a browser password when the result ends with the password marker', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const call = { type: 'toolCall', id: 'call', name: 'browser_tool', arguments: { command: 'fill @e2 fake-password-marker-test' } }
    const result = { role: 'toolResult', toolCallId: 'call', toolName: 'browser_tool', content: [{ type: 'text', text: 'Filled password field @e2' }] }
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'entry', call, result }] }) + '\n')

    const bundle = serializeSession(tmpDir, session.id)
    expect(bundle).not.toBeNull()
    const contents = bundle!.files.map(file => Buffer.from(file.contentBase64, 'base64').toString()).join('')
    expect(contents).toContain('"command":"fill @e2 "')
    expect(contents).not.toContain('fake-password-marker-test')
  })

  it('rejects JSONL history with a non-increasing commit sequence', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    const marker = JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [] })
    writeFileSync(join(storeDir, 'main.jsonl'), `${marker}\n${marker}\n`)

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects duplicate JSONL sidecar records', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'task.sidecar', id: 2, ordinal: 0 }] }) + '\n')
    const record = JSON.stringify({ format: 1, seq: 1, ordinal: 0, type: 'record', payload: { type: 'task', value: { id: 2, state: { status: 'running' } } } })
    writeFileSync(join(storeDir, 'task-2.jsonl'), `${record}\n${record}\n`)

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects a JSONL sidecar whose payload does not match its commit', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'task.sidecar', id: 2, ordinal: 0 }] }) + '\n')
    writeFileSync(join(storeDir, 'task-2.jsonl'), JSON.stringify({ format: 1, seq: 1, ordinal: 0, type: 'record', payload: { type: 'task', value: { id: 3, state: { status: 'running' } } } }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects an unfinished JSONL commit whose sidecar contains a password', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [] }) + '\n')
    writeFileSync(join(storeDir, 'task-2.jsonl'), JSON.stringify({ format: 1, seq: 2, ordinal: 0, type: 'record', payload: { type: 'task', value: { state: { secret: 'fixture-password' } } } }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects an unreferenced sidecar record from a committed JSONL sequence', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [] }) + '\n')
    writeFileSync(join(storeDir, 'task-2.jsonl'), JSON.stringify({ format: 1, seq: 1, ordinal: 0, type: 'record', payload: { type: 'task', value: { id: 2, state: { status: 'running', secret: 'test-secret' } } } }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('rejects a JSONL commit that refers to a missing sidecar record', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)
    const storeDir = join(sessionDir, 'durable-store')
    mkdirSync(storeDir)
    writeFileSync(join(storeDir, 'main.jsonl'), JSON.stringify({ format: 1, seq: 1, type: 'commit', writes: [{ type: 'task.sidecar', id: 2, ordinal: 0 }] }) + '\n')

    expect(serializeSession(tmpDir, session.id)).toBeNull()
  })

  it('includes plan and data files in bundle', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    // Create plan and data files
    mkdirSync(join(sessionDir, 'plans'), { recursive: true })
    writeFileSync(join(sessionDir, 'plans', 'my-plan.md'), '# Plan\n- [ ] Step 1')

    mkdirSync(join(sessionDir, 'data'), { recursive: true })
    writeFileSync(join(sessionDir, 'data', 'result.json'), '{"rows":[]}')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.files).toHaveLength(2)
    const paths = bundle!.files.map(f => f.relativePath).sort()
    expect(paths).toEqual([join('data', 'result.json'), join('plans', 'my-plan.md')])
  })

  it('preserves notes.md in bundle', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    writeFileSync(join(sessionDir, 'notes.md'), '# My Notes\nSome notes here.')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const notesFile = bundle!.files.find(f => f.relativePath === 'notes.md')
    expect(notesFile).toBeDefined()
    expect(Buffer.from(notesFile!.contentBase64, 'base64').toString()).toBe('# My Notes\nSome notes here.')
  })

  it('skips tmp/ directory', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    mkdirSync(join(sessionDir, 'tmp'), { recursive: true })
    writeFileSync(join(sessionDir, 'tmp', 'cache.dat'), 'cached data')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const tmpFiles = bundle!.files.filter(f => f.relativePath.startsWith('tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('skips dotfiles', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    writeFileSync(join(sessionDir, '.hidden'), 'secret')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const dotFiles = bundle!.files.filter(f => f.relativePath.startsWith('.'))
    expect(dotFiles).toHaveLength(0)
  })

  it('does not include session.jsonl in files array', () => {
    const session = makeStoredSession()
    setupSessionDir(tmpDir, session)

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const jsonlFiles = bundle!.files.filter(f => f.relativePath.includes('session.jsonl'))
    expect(jsonlFiles).toHaveLength(0)
  })

  it('returns null for non-existent session', () => {
    const bundle = serializeSession(tmpDir, 'non-existent')
    expect(bundle).toBeNull()
  })

  it('preserves session metadata in header', () => {
    const session = makeStoredSession({
      isFlagged: true,
      permissionMode: 'ask' as any,
    })
    setupSessionDir(tmpDir, session)

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.session.header.isFlagged).toBe(true)
    expect(bundle!.session.header.permissionMode).toBe('ask')
  })
})

describe('validateBundle', () => {
  it('accepts valid bundle', () => {
    const bundle = {
      version: 1,
      session: {
        header: { id: 'test', createdAt: 1000 },
        messages: [],
      },
      files: [],
    }
    expect(validateBundle(bundle)).toBe(true)
  })

  it('rejects null', () => {
    expect(validateBundle(null)).toBe(false)
  })

  it('rejects wrong version', () => {
    expect(validateBundle({ version: 2, session: { header: { id: 'x', createdAt: 1 }, messages: [] }, files: [] })).toBe(false)
  })

  it('rejects missing session', () => {
    expect(validateBundle({ version: 1, files: [] })).toBe(false)
  })

  it('rejects missing header', () => {
    expect(validateBundle({ version: 1, session: { messages: [] }, files: [] })).toBe(false)
  })

  it('rejects missing messages array', () => {
    expect(validateBundle({ version: 1, session: { header: { id: 'x', createdAt: 1 } }, files: [] })).toBe(false)
  })

  it('rejects missing files array', () => {
    expect(validateBundle({ version: 1, session: { header: { id: 'x', createdAt: 1 }, messages: [] } })).toBe(false)
  })

  it('rejects header without id', () => {
    expect(validateBundle({ version: 1, session: { header: { createdAt: 1 }, messages: [] }, files: [] })).toBe(false)
  })

  it('rejects header without createdAt', () => {
    expect(validateBundle({ version: 1, session: { header: { id: 'x' }, messages: [] }, files: [] })).toBe(false)
  })
})
