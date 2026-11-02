import { describe, expect, it } from 'bun:test'
import { expandSessionPath, makeSessionPathPortable } from '../jsonl.ts'
import { remapSessionFileReferences } from '../session-files.ts'

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
})
