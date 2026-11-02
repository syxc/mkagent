import { describe, expect, it } from 'bun:test'
import { expandSessionPath, makeSessionPathPortable } from '../jsonl.ts'
import { importSessionMessages, remapSessionFileReferences } from '../session-files.ts'
import type { SessionBundle } from '../bundle.ts'

describe('session path portability', () => {
  for (const source of ['/tmp/source', '/tmp/source "with quotes"', 'C:\\fixture\\source']) it(`preserves boundaries and JSON encoding for ${source}`, () => {
    const path = source + (source.startsWith('C:') ? '\\attachments\\file.txt' : '/attachments/file.txt')
    const value = {
      path,
      text: `file "${path}"`,
      sibling: source + '-other/file.txt',
      embedded: '/outside' + source + '/file.txt',
    }
    const portable = makeSessionPathPortable(JSON.stringify(value), source)
    const restored = JSON.parse(expandSessionPath(portable, '/tmp/target "$& with quotes"'))
    expect(restored.path).toBe('/tmp/target "$& with quotes"/attachments/file.txt')
    expect(restored.text).toContain('/tmp/target "$& with quotes"/attachments/file.txt')
    expect(restored.sibling).toBe(value.sibling)
    expect(restored.embedded).toBe(value.embedded)
  })

  it('rejects traversal in a reference under the source directory', () => {
    expect(() => remapSessionFileReferences({ path: '/tmp/source/../outside.txt' }, '/tmp/source', '/tmp/target'))
      .toThrow('path traversal')
  })

  it('imports an old Windows package whose header belongs to another home directory', () => {
    const path = 'C:\\old home\\workspace\\sessions\\original\\attachments\\file.txt'
    const bundle = {
      version: 1,
      session: {
        header: { id: 'original', createdAt: 1, workspaceRootPath: '~\\foreign\\workspace' },
        messages: [{ id: 'file', type: 'user', timestamp: 1, content: `See ${path}`, attachments: [{
          id: 'file', name: 'file.txt', type: 'text', mimeType: 'text/plain', size: 0, storedPath: path,
        }] }],
      },
      files: [{ relativePath: 'attachments/file.txt', contentBase64: '', size: 0 }],
    } as SessionBundle
    const [message] = importSessionMessages(bundle, '/tmp/new-home/session')
    expect(message!.attachments![0]!.storedPath).toBe('/tmp/new-home/session/attachments/file.txt')
    expect(message!.content).toBe('See /tmp/new-home/session/attachments/file.txt')
  })
})
