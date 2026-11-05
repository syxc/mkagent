/** Product authority records only identities and digests, never native transcript contents. */
export interface NativeSessionReference {
  version: 1
  sessionId: string
  nativeSessionId: string
  conversationId: number
  revision: number
  sessionFile: string
  leaf: string | null
  name: string | null
  digest: string
  manifestDigest: string
}

export function parseNativeSessionReference(value: unknown): NativeSessionReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const text = (field: string) => typeof item[field] === 'string' && item[field].length > 0 && !item[field].includes('\0')
  const hash = (field: string) => typeof item[field] === 'string' && /^[a-f0-9]{64}$/.test(item[field])
  if (item.version !== 1 || !text('sessionId') || !text('nativeSessionId') || !text('sessionFile')
    || !Number.isSafeInteger(item.conversationId) || Number(item.conversationId) < 0
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0
    || (item.leaf !== null && !text('leaf')) || (item.name !== null && typeof item.name !== 'string')
    || !hash('digest') || !hash('manifestDigest')) return null
  return {
    version: 1, sessionId: item.sessionId as string, nativeSessionId: item.nativeSessionId as string,
    conversationId: item.conversationId as number, revision: item.revision as number,
    sessionFile: item.sessionFile as string, leaf: item.leaf as string | null, name: item.name as string | null,
    digest: item.digest as string, manifestDigest: item.manifestDigest as string,
  }
}
