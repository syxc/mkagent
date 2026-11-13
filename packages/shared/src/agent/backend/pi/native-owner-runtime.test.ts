import { expect, test } from 'bun:test'
import { parseOwnerEvent } from './native-owner-runtime'
import type { NativeSessionReference } from '../../../sessions/native-session-reference'

const scope = { ownerSessionId: 'owner', runtimeGeneration: 1 }
const reference: NativeSessionReference = { version: 1, sessionId: 'owner', nativeSessionId: 'native-owner', conversationId: 1,
  revision: 3, sessionFile: '/tmp/isolated-owner/native-session/session.jsonl', leaf: null, name: null,
  digest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) }
const frames = [
  { type: 'owner_prepare', sourceNativeSessionId: 'native-owner', operation: { type: 'fork', entryId: 'entry', position: 'at' },
    fork: { nativeLeafId: 'entry', durableEntryId: 1 }, sourceReference: reference },
  { type: 'owner_source_closed', reference },
  { type: 'owner_target_bound', nativeSessionId: 'native-owner', reference },
]

for (const frame of frames) {
  const field = frame.type === 'owner_prepare' ? 'sourceReference' : 'reference'
  test(`JSONL boundary retains and normalizes the ${frame.type} reference`, () => {
    const parsed = parseOwnerEvent({ ...scope, transactionId: 'tx', ...frame,
      [field]: { ...reference, entryIds: [{ nativeId: 'entry' }], extra: 'discard this field' } }, scope)
    expect(parsed).toMatchObject({ ...scope, transactionId: 'tx', [field]: reference })
    const actual = parsed?.type === 'owner_prepare' ? parsed.sourceReference
      : parsed?.type === 'owner_source_closed' || parsed?.type === 'owner_target_bound' ? parsed.reference : undefined
    expect(actual).toEqual(reference)
  })
  test(`JSONL boundary rejects a malformed ${frame.type} reference`, () => {
    expect(parseOwnerEvent({ ...scope, transactionId: 'tx', ...frame, [field]: { ...reference, digest: 'invalid' } }, scope)).toBeNull()
  })
}

test('NEW without references keeps the existing owner protocol', () => {
  expect(parseOwnerEvent({ ...scope, transactionId: 'tx', type: 'owner_source_closed' }, scope))
    .toEqual({ ...scope, transactionId: 'tx', type: 'owner_source_closed' })
})
