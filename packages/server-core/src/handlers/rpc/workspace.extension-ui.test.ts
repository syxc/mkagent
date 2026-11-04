import { expect, test } from 'bun:test'
import { RPC_CHANNELS } from '@mkagent/shared/protocol'
import type { ExtensionUIConnection, ExtensionUIUpdate } from '@mkagent/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { SessionExtensionUI } from '../../sessions/extension-ui'
import { registerWorkspaceCoreHandlers } from './workspace'

test.each([true, false])('workspace switch revokes old UI only when the workspace changes (%s)', async change => {
  const updates: ExtensionUIUpdate[] = []
  const availability: boolean[] = []
  const ui = new SessionExtensionUI((_client, update) => updates.push(update))
  let connection: ExtensionUIConnection | undefined
  connection = ui.port('session-A').connect({
    setAvailable(value) { availability.push(value) },
    async respond() { return true },
  })
  ui.attach('session-A', 'client', 'lease')
  connection.event({ type: 'extension_ui_state', uiEpoch: 'epoch', available: true, reset: true })
  connection.event({ type: 'extension_ui_request', method: 'input', title: 'Waiting', uiEpoch: 'epoch', id: 'dialog' })
  updates.length = 0
  const handlers = new Map<string, HandlerFn>()
  const routing: string[] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
    updateClientWorkspace(_client, workspace) { routing.push(workspace) },
  }
  const deps = {
    sessionManager: { disconnectExtensionUI: (clientId: string) => ui.disconnect(clientId) },
    platform: { logger: { info() {}, debug() {}, error() {}, warn() {} } },
  } as unknown as HandlerDeps
  registerWorkspaceCoreHandlers(server, deps)
  const target = change ? 'workspace-B-fixture' : 'workspace-A-fixture'
  await handlers.get(RPC_CHANNELS.window.SWITCH_WORKSPACE)!({ clientId: 'client', workspaceId: 'workspace-A-fixture', webContentsId: null }, target)
  connection.event({ type: 'extension_ui_request', method: 'set_editor_text', text: 'old workspace content', uiEpoch: 'epoch', id: 'effect' })
  expect(routing).toEqual([target])
  if (change) {
    expect(availability.at(-1)).toBe(false)
    expect(updates).toEqual([])
    expect(ui.attach('session-A', 'other-client', 'other-lease').requests).toEqual([])
    expect(await ui.respond('session-A', 'client', 'lease', 'epoch', {
      type: 'extension_ui_response', id: 'dialog', value: 'late',
    })).toBe(false)
  } else {
    expect(availability.at(-1)).toBe(true)
    expect(updates).toHaveLength(1)
  }
})
