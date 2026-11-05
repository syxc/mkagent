import { isDeepStrictEqual } from 'node:util'
import type { StoredMessage, StoredSession } from './types.ts'

/** The caller verifies the native snapshot; this view never owns an execution tree. */
export interface NativeProductTree {
  entries: readonly { id: string; parentId: string | null; type: string; message?: unknown }[]
  entryIds: readonly { nativeId: string; productMessageId?: string }[]
  leaf: string | null
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function partitionNativeProductHistory(
  session: Pick<StoredSession, 'messages' | 'nativeArchivedMessages'>,
  tree: NativeProductTree,
  options: {
    sourceSessionId: string
    targetSessionId: string
    leaf: string | null
    sourceOnlyMessageIds?: ReadonlySet<string>
  },
): Required<Pick<StoredSession, 'messages' | 'nativeArchivedMessages'>> {
  const rows = new Map<string, StoredMessage>()
  const orders = new Set<number>()
  let nextOrder = 0
  for (const row of [...session.messages, ...(session.nativeArchivedMessages ?? [])]) {
    const previous = rows.get(row.id)
    if (previous) {
      if (!isDeepStrictEqual(previous, row)) throw new Error('Conflicting native product message identity')
      continue
    }
    const history = row.nativeHistory
    if (history) {
      if (!Number.isSafeInteger(history.order) || history.order < 0 || orders.has(history.order)
        || (history.anchor !== undefined && history.anchor !== null && (typeof history.anchor !== 'string' || !history.anchor))
        || (history.sourceSessionId !== undefined && (typeof history.sourceSessionId !== 'string' || !history.sourceSessionId))) {
        throw new Error('Invalid native product message history')
      }
      orders.add(history.order)
      nextOrder = Math.max(nextOrder, history.order + 1)
    }
    rows.set(row.id, structuredClone(row))
  }
  const entries = new Map(tree.entries.map(entry => [entry.id, entry]))
  const active = new Set<string>()
  for (let id = options.leaf; id !== null;) {
    const entry = entries.get(id)
    if (!entry || active.has(id)) throw new Error('Native product history leaf is unavailable')
    active.add(id)
    id = entry.parentId
  }

  const links = new Map<string, Set<string>>()
  const addLink = (productId: string, nativeId: string) => {
    const ids = links.get(productId) ?? new Set<string>()
    ids.add(nativeId)
    links.set(productId, ids)
  }
  for (const link of tree.entryIds) if (link.productMessageId) addLink(link.productMessageId, link.nativeId)

  const calls = new Map<string, string[]>()
  const results = new Map<string, string[]>()
  for (const entry of tree.entries) {
    const message = entry.message
    if (!object(message)) continue
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!object(part) || part.type !== 'toolCall' || typeof part.id !== 'string' || !part.id) continue
        const ids = calls.get(part.id) ?? []
        ids.push(entry.id)
        calls.set(part.id, ids)
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), entry.id])
    }
  }
  const tools = new Map<string, StoredMessage[]>()
  for (const row of rows.values()) {
    if (row.type === 'tool' && row.toolUseId) tools.set(row.toolUseId, [...(tools.get(row.toolUseId) ?? []), row])
  }
  for (const [callId, toolRows] of tools) {
    if (toolRows.length !== 1 || links.has(toolRows[0]!.id) || calls.get(callId)?.length !== 1) continue
    const caller = calls.get(callId)![0]!
    const matched: string[] = []
    for (const result of results.get(callId) ?? []) {
      const seen = new Set<string>()
      for (let id = entries.get(result)?.parentId; id != null && !seen.has(id);) {
        if (id === caller) { matched.push(result); break }
        seen.add(id)
        id = entries.get(id)?.parentId
      }
    }
    if (matched.length === 1) addLink(toolRows[0]!.id, matched[0]!)
  }

  const messages: StoredMessage[] = []
  const nativeArchivedMessages: StoredMessage[] = []
  for (const row of rows.values()) {
    const linked = links.get(row.id)
    const history = row.nativeHistory ?? { order: nextOrder++ }
    if (!Number.isSafeInteger(history.order)) throw new Error('Native product message order is exhausted')
    if (!linked?.size && history.anchor === undefined) history.anchor = tree.leaf
    if (history.anchor !== undefined && history.anchor !== null && !entries.has(history.anchor)) {
      throw new Error('Native product message anchor is unavailable')
    }
    if (row.isQueued || (!linked?.size && options.sourceOnlyMessageIds?.has(row.id))) {
      history.sourceSessionId ??= options.sourceSessionId
    } else if (linked?.size) delete history.sourceSessionId
    row.nativeHistory = history
    const owned = !history.sourceSessionId || history.sourceSessionId === options.targetSessionId
    const visible = owned && (row.isQueued || (linked?.size
      ? [...linked].some(id => active.has(id))
      : history.anchor === null || (history.anchor !== undefined && active.has(history.anchor))))
    const destination = visible ? messages : nativeArchivedMessages
    destination.push(row)
  }
  const byOrder = (a: StoredMessage, b: StoredMessage) => a.nativeHistory!.order - b.nativeHistory!.order
  return { messages: messages.sort(byOrder), nativeArchivedMessages: nativeArchivedMessages.sort(byOrder) }
}
