import { isDeepStrictEqual } from 'node:util'
import { readTrustedNativeSession, type TrustedNativeSession } from './native-session-source'

type NativeIdentity = Parameters<typeof readTrustedNativeSession>[0]

export interface NativeSwitchProof {
  tree: TrustedNativeSession
}

export function prepareNativeSwitchProof(identity: NativeIdentity): NativeSwitchProof {
  return { tree: readTrustedNativeSession(identity) }
}

/** The released writer may append shutdown metadata without replacing the reserved history. */
export function closeNativeSwitchProof(prepared: NativeSwitchProof, identity: NativeIdentity): NativeSwitchProof {
  const tree = readTrustedNativeSession(identity)
  const before = prepared.tree
  if (tree.reference.sessionId !== before.reference.sessionId
    || tree.reference.nativeSessionId !== before.reference.nativeSessionId
    || tree.reference.conversationId !== before.reference.conversationId
    || tree.reference.revision < before.reference.revision
    || !isDeepStrictEqual(tree.header, before.header)
    || !isDeepStrictEqual(tree.entries.slice(0, before.entries.length), before.entries)) {
    throw new Error('Native switch target changed its reserved history')
  }
  for (const [index, previous] of before.entryIds.entries()) {
    const current = tree.entryIds[index]
    if (!current || current.nativeId !== previous.nativeId || current.durableId !== previous.durableId
      || (previous.productMessageId !== undefined && current.productMessageId !== previous.productMessageId)) {
      throw new Error('Native switch target changed its reserved mapping')
    }
  }
  return { tree }
}

/** Resume retains the target's native identity and complete tree. It never copies source history. */
export function verifyNativeSwitchTarget(closed: NativeSwitchProof, identity: NativeIdentity): void {
  const tree = readTrustedNativeSession(identity)
  const before = closed.tree
  if (tree.reference.sessionId !== before.reference.sessionId
    || tree.reference.nativeSessionId !== before.reference.nativeSessionId
    || tree.reference.conversationId !== before.reference.conversationId
    || tree.reference.revision < before.reference.revision
    || tree.reference.leaf !== before.reference.leaf || tree.reference.name !== before.reference.name
    || tree.hasName !== before.hasName || !isDeepStrictEqual(tree.header, before.header)
    || !isDeepStrictEqual(tree.entries, before.entries) || !isDeepStrictEqual(tree.entryIds, before.entryIds)) {
    throw new Error('Native switch bound target does not match its released tree')
  }
}
