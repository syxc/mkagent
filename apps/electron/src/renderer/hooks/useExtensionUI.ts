import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ExtensionUIResponse, ExtensionUIUpdate } from '@mkagent/shared/protocol'
import { ExtensionUIClient } from '../lib/extension-ui-client'

export function useExtensionUI(workspaceId: string | null, sessionIds: Iterable<string>,
  effect: (sessionId: string, effect: NonNullable<ExtensionUIUpdate['effect']>) => void) {
  const effectRef = useRef(effect)
  useEffect(() => { effectRef.current = effect }, [effect])
  const client = useMemo(() => new ExtensionUIClient(window.electronAPI,
    (sessionId, value) => effectRef.current(sessionId, value)), [workspaceId])
  const snapshots = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  useEffect(() => {
    client.start()
    return () => client.dispose()
  }, [client])
  useEffect(() => {
    client.setSessions(workspaceId ? sessionIds : [])
  }, [client, workspaceId, sessionIds])
  const respond = useCallback((sessionId: string, uiEpoch: string, response: ExtensionUIResponse) =>
    client.respond(sessionId, uiEpoch, response), [client])
  return { snapshots, respond }
}
