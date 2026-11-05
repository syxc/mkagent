import { isDeepStrictEqual } from 'node:util'
import {
  getSessionPath, parseNativeSessionReference, remapSessionFileReferences,
  type NativeSessionOwnerRecord, type NativeSessionReference,
} from '@mkagent/shared/sessions'
import type { PiNativeOwnerRequest } from '../../../shared/src/agent/backend/pi/native-owner-protocol'
import { nativeForkPlan, readTrustedNativeSession, type TrustedNativeSession } from './native-session-source'

export interface NativeForkProof {
  sourcePath: string
  tree: TrustedNativeSession
  record: NonNullable<NativeSessionOwnerRecord['fork']>
}

interface SourceIdentity {
  workspaceRootPath: string
  sessionId: string
  nativeSessionId: string
  reference: NativeSessionReference
}

/** Derive every anchor again from the registered projection, before closing its owner. */
export function prepareNativeForkProof(identity: SourceIdentity, request: PiNativeOwnerRequest): NativeForkProof {
  if (request.operation.type !== 'fork' || !request.fork
    || !isDeepStrictEqual(parseNativeSessionReference(request.sourceReference), identity.reference)) {
    throw new Error('Native fork requires a registered projection and exact anchor (D3.4)')
  }
  const tree = readTrustedNativeSession(identity)
  const { entryId, position } = request.operation
  const plan = nativeForkPlan(tree, entryId, position)
  if (request.fork.nativeLeafId !== plan.nativeLeafId || request.fork.durableEntryId !== plan.durableEntryId
    || request.fork.selectedText !== plan.selectedText) throw new Error('Native fork anchor does not match its committed tree')
  return {
    sourcePath: getSessionPath(identity.workspaceRootPath, identity.sessionId), tree,
    record: { entryId, position, nativeLeafId: plan.nativeLeafId, durableEntryId: plan.durableEntryId,
      source: tree.reference, ...(request.inputId ? { inputId: request.inputId } : {}) },
  }
}

/** Shutdown may append entries, but cannot replace prepared identities or existing content. */
export function closeNativeForkProof(prepared: NativeForkProof, identity: SourceIdentity): NativeForkProof {
  const tree = readTrustedNativeSession(identity)
  if (identity.sessionId !== prepared.record.source.sessionId
    || tree.reference.nativeSessionId !== prepared.tree.reference.nativeSessionId
    || tree.reference.conversationId !== prepared.tree.reference.conversationId
    || tree.reference.revision < prepared.tree.reference.revision
    || !isDeepStrictEqual(tree.header, prepared.tree.header)
    || !isDeepStrictEqual(tree.entries.slice(0, prepared.tree.entries.length), prepared.tree.entries)) {
    throw new Error('Native fork source changed its prepared history')
  }
  for (const [index, previous] of prepared.tree.entryIds.entries()) {
    const current = tree.entryIds[index]
    if (!current || current.nativeId !== previous.nativeId || current.durableId !== previous.durableId
      || (previous.productMessageId !== undefined && current.productMessageId !== previous.productMessageId)) {
      throw new Error('Native fork source changed its prepared mapping')
    }
  }
  const plan = nativeForkPlan(tree, prepared.record.entryId, prepared.record.position)
  if (plan.nativeLeafId !== prepared.record.nativeLeafId || plan.durableEntryId !== prepared.record.durableEntryId
    || plan.selectedText !== nativeForkPlan(prepared.tree, prepared.record.entryId, prepared.record.position).selectedText) {
    throw new Error('Native fork source changed its prepared anchor')
  }
  return { ...prepared, tree, record: { ...prepared.record, source: tree.reference } }
}

/** Binding proves the new native identity and the entire copied tree, not just its active leaf. */
export function verifyNativeForkTarget(proof: NativeForkProof, identity: SourceIdentity): void {
  const target = readTrustedNativeSession(identity)
  const expected = remapSessionFileReferences(proof.tree.entries, proof.sourcePath,
    getSessionPath(identity.workspaceRootPath, identity.sessionId)).map((entry, index) => ({
    ...entry, id: proof.tree.entries[index]!.id, parentId: proof.tree.entries[index]!.parentId,
    type: proof.tree.entries[index]!.type,
  }))
  if (target.reference.nativeSessionId === proof.tree.reference.nativeSessionId
    || target.reference.conversationId === proof.tree.reference.conversationId
    || target.reference.revision <= proof.tree.reference.revision
    || target.header.parentSession !== proof.tree.reference.sessionFile
    || target.reference.leaf !== proof.record.nativeLeafId
    || target.reference.name !== proof.tree.reference.name || target.hasName !== proof.tree.hasName
    || !isDeepStrictEqual(target.entries, expected)
    || !isDeepStrictEqual(target.entryIds, proof.tree.entryIds)) {
    throw new Error('Native fork target does not match its closed source tree')
  }
}
