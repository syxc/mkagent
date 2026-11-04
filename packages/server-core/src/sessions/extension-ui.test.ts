import { expect, test } from 'bun:test'
import type { ExtensionUIResponse, ExtensionUIUpdate } from '@mkagent/shared/protocol'
import { SessionExtensionUI } from './extension-ui'

function fixture(ack: () => Promise<boolean> = async () => true) {
  const updates: Array<{ clientId: string; update: ExtensionUIUpdate }> = []
  const available: boolean[] = []
  const responses: ExtensionUIResponse[] = []
  const ui = new SessionExtensionUI((clientId, update) => updates.push({ clientId, update }))
  ui.attach('session', 'client', 'subscription')
  const connection = ui.port('session').connect({
    setAvailable: value => available.push(value),
    respond: async (uiEpoch, response) => {
      responses.push(response)
      connection.event({ type: 'extension_ui_closed', uiEpoch, id: response.id })
      return ack()
    },
  })
  connection.event({ type: 'extension_ui_state', uiEpoch: 'epoch', available: true, reset: true })
  return {
    ui, updates, available, responses, connection,
    snapshot: () => ui.attach('session', 'client', 'subscription'),
    input(id = 'input') {
      connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id, method: 'input', title: 'Input' })
    },
  }
}

test('preserves keyed empty values and publishes effects only to current client subscriptions', () => {
  const f = fixture()
  f.ui.attach('session', 'second', 'second-subscription')
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'status', method: 'setStatus', statusKey: 'key', statusText: '' })
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'widget', method: 'setWidget', widgetKey: 'key', widgetLines: [], widgetPlacement: 'belowEditor' })
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'title', method: 'setTitle', title: '' })
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'draft', method: 'set_editor_text', text: '' })
  expect(f.snapshot()).toMatchObject({
    statuses: [{ key: 'key', text: '' }], widgets: [{ key: 'key', lines: [], placement: 'belowEditor' }], title: '',
  })
  expect(f.updates.slice(-2).map(item => [item.clientId, item.update.subscriptionId, item.update.effect?.method]))
    .toEqual([['client', 'subscription', 'set_editor_text'], ['second', 'second-subscription', 'set_editor_text']])
  expect(f.snapshot()).not.toHaveProperty('effect')
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'delete-status', method: 'setStatus', statusKey: 'key', statusText: undefined })
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'delete-widget', method: 'setWidget', widgetKey: 'key', widgetLines: undefined })
  expect(f.snapshot()).toMatchObject({ statuses: [], widgets: [] })
})

test('requires the current session client lease, epoch and native response type', async () => {
  const f = fixture()
  f.input()
  const response: ExtensionUIResponse = { type: 'extension_ui_response', id: 'input', value: '' }
  expect(await f.ui.respond('other-session', 'client', 'subscription', 'epoch', response)).toBe(false)
  expect(await f.ui.respond('session', 'other-client', 'subscription', 'epoch', response)).toBe(false)
  expect(await f.ui.respond('session', 'other-client', JSON.parse('{}').subscriptionId, 'epoch', response)).toBe(false)
  expect(await f.ui.respond('session', 'client', 'old-subscription', 'epoch', response)).toBe(false)
  expect(await f.ui.respond('session', 'client', 'subscription', 'old-epoch', response)).toBe(false)
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', { ...response, value: 1 })).toBe(false)
  expect(f.responses).toHaveLength(0)
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', response)).toBe(true)
  expect(f.responses).toEqual([response])
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', response)).toBe(false)
})

test('accepts cancellation before mixed fields and validates select options and false confirmations', async () => {
  const f = fixture()
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'select', method: 'select', title: 'Choose', options: ['', 'second'] })
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', { type: 'extension_ui_response', id: 'select', value: 'other' })).toBe(false)
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', { type: 'extension_ui_response', id: 'select', value: '' })).toBe(true)
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'confirm', method: 'confirm', title: 'Confirm', message: 'Continue?' })
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', { type: 'extension_ui_response', id: 'confirm', confirmed: false })).toBe(true)
  f.input()
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', { type: 'extension_ui_response', id: 'input', cancelled: true, value: 42 })).toBe(true)
  expect(f.responses.at(-1)).toEqual({ type: 'extension_ui_response', id: 'input', cancelled: true })
})

test('waits for the worker acknowledgement even after the dialog closes', async () => {
  const gate = Promise.withResolvers<boolean>()
  const f = fixture(() => gate.promise)
  f.input()
  let completed = false
  const response = { type: 'extension_ui_response', id: 'input', value: 'answer' }
  const receipt = f.ui.respond('session', 'client', 'subscription', 'epoch', response)
    .then(value => { completed = true; return value })
  expect(f.snapshot().requests).toEqual([])
  expect(completed).toBe(false)
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', response)).toBe(false)
  gate.resolve(true)
  expect(await receipt).toBe(true)
})

test('retires old backend callbacks and rejects their late acknowledgements', async () => {
  const gate = Promise.withResolvers<boolean>()
  const f = fixture(() => gate.promise)
  f.input()
  const receipt = f.ui.respond('session', 'client', 'subscription', 'epoch', { type: 'extension_ui_response', id: 'input', value: 'answer' })
  const replacement = f.ui.port('session').connect({ setAvailable() {}, respond: async () => true })
  replacement.event({ type: 'extension_ui_state', uiEpoch: 'replacement', available: true, reset: true })
  replacement.event({ type: 'extension_ui_request', uiEpoch: 'replacement', id: 'title', method: 'setTitle', title: 'Replacement' })
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'late-title', method: 'setTitle', title: 'Old' })
  f.connection.close()
  gate.resolve(true)
  expect(await receipt).toBe(false)
  expect(f.snapshot()).toMatchObject({ uiEpoch: 'replacement', available: true, title: 'Replacement' })
})

test('disconnect cancels the last responder and reconnect uses a fresh subscription without replaying effects', async () => {
  const f = fixture()
  f.input()
  f.connection.event({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'draft', method: 'set_editor_text', text: 'old effect' })
  f.ui.disconnect('client')
  expect(f.available.at(-1)).toBe(false)
  const snapshot = f.ui.attach('session', 'client', 'replacement-subscription')
  expect(snapshot).toMatchObject({ available: false, requests: [] })
  expect(snapshot).not.toHaveProperty('effect')
  f.connection.event({ type: 'extension_ui_state', uiEpoch: 'epoch', available: true, reset: false })
  f.input('replacement-input')
  f.ui.detach('session', 'client', 'subscription')
  expect(f.updates.at(-1)?.update.subscriptionId).toBe('replacement-subscription')
  expect(await f.ui.respond('session', 'client', 'subscription', 'epoch', { type: 'extension_ui_response', id: 'replacement-input', value: 'answer' })).toBe(false)
  expect(await f.ui.respond('session', 'client', 'replacement-subscription', 'epoch', { type: 'extension_ui_response', id: 'replacement-input', value: 'answer' })).toBe(true)
})

test('a deleted session rejects late backend connections and preserves the replacement session', () => {
  const f = fixture()
  const late = f.ui.port('session')
  f.ui.remove('session')
  const replacement = f.ui.attach('session', 'client', 'new-subscription')
  const availability: boolean[] = []
  const connection = late.connect({ setAvailable: value => availability.push(value), respond: async () => true })
  connection.event({ type: 'extension_ui_state', uiEpoch: 'late', available: true, reset: true })
  connection.close()
  expect(availability).toEqual([false])
  expect(f.ui.attach('session', 'client', 'new-subscription')).toEqual(replacement)
})
