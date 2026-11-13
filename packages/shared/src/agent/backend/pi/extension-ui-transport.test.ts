import { expect, test } from 'bun:test';
import type { ExtensionUIController, ExtensionUIEvent, ExtensionUIHostPort } from '../../../protocol/extension-ui.ts';
import { PiExtensionUITransport } from './extension-ui-transport.ts';

function fixture(available = true, sent = true) {
  let controller: ExtensionUIController | undefined;
  const commands: Record<string, unknown>[] = [];
  const events: ExtensionUIEvent[] = [];
  const lifecycle = { resets: 0, closes: 0 };
  const port: ExtensionUIHostPort = {
    connect(value) {
      controller = value;
      value.setAvailable(available);
      return {
        event: event => { events.push(event); },
        reset: () => { lifecycle.resets++; },
        close: () => { lifecycle.closes++; },
      };
    },
  };
  const transport = new PiExtensionUITransport(port, command => { commands.push(command); return sent; });
  return {
    transport, commands, events, lifecycle,
    get controller(): ExtensionUIController {
      if (!controller) throw new Error('UI port did not connect');
      return controller;
    },
    responseCommand() {
      const command = commands.findLast(value => value.type === 'extension_ui_response');
      if (!command) throw new Error('No UI response was sent');
      expect(typeof command.responseId).toBe('string');
      return command;
    },
  };
}

test('caches responder availability before a worker exists and sends only changes', () => {
  const f = fixture(true, false);
  expect(f.transport.available).toBe(true);
  f.controller.setAvailable(true);
  f.controller.setAvailable(false);
  f.controller.setAvailable(false);
  expect(f.commands).toEqual([
    { type: 'extension_ui_available', available: true },
    { type: 'extension_ui_available', available: false },
  ]);
  expect(f.transport.available).toBe(false);
  f.transport.dispose();
});

test('validates native UI frames independently from chat and tool approval events', () => {
  const f = fixture();
  expect(f.transport.handleMessage({ type: 'pre_tool_use_request', id: 'approval' })).toBe(false);
  expect(f.transport.handleMessage({ type: 'event', event: { type: 'agent_end' } })).toBe(false);
  const request = { type: 'extension_ui_request', uiEpoch: 'epoch', id: 'dialog', method: 'select', title: 'Choose', options: ['', 'two'] } satisfies ExtensionUIEvent;
  expect(f.transport.handleMessage(request)).toBe(true);
  expect(f.events).toEqual([request]);
  f.transport.handleMessage({ ...request, uiEpoch: 1 });
  f.transport.handleMessage({ ...request, options: ['two', 3] });
  f.transport.handleMessage({ ...request, method: 'editor', prefill: 3 });
  f.transport.handleMessage({ ...request, method: 'notify', message: 'notice', notifyType: 'fatal' });
  expect(f.events).toHaveLength(1);
  f.transport.dispose();
});

test('returns the matching worker acknowledgement for concurrent UI responses', async () => {
  const f = fixture();
  const first = f.controller.respond('epoch', { type: 'extension_ui_response', id: 'first', confirmed: false });
  const firstCommand = f.responseCommand();
  const second = f.controller.respond('epoch', { type: 'extension_ui_response', id: 'second', value: '' });
  const secondCommand = f.responseCommand();
  expect(firstCommand.responseId).not.toBe(secondCommand.responseId);
  expect(secondCommand).toMatchObject({ uiEpoch: 'epoch', id: 'second', value: '' });
  f.transport.handleMessage({ type: 'extension_ui_response_result', id: 'unknown', accepted: true });
  f.transport.handleMessage({ type: 'extension_ui_response_result', id: secondCommand.responseId, accepted: true });
  f.transport.handleMessage({ type: 'extension_ui_response_result', id: firstCommand.responseId, accepted: false });
  expect(await Promise.all([first, second])).toEqual([false, true]);
  f.transport.handleMessage({ type: 'extension_ui_response_result', id: firstCommand.responseId, accepted: true });
  f.transport.dispose();
});

test('keeps a response pending through dialog closure and cancels acknowledgements on epoch reset', async () => {
  const f = fixture();
  const accepted = f.controller.respond('epoch', { type: 'extension_ui_response', id: 'dialog', value: 'answer' });
  const command = f.responseCommand();
  f.transport.handleMessage({ type: 'extension_ui_closed', uiEpoch: 'epoch', id: 'dialog' });
  f.transport.handleMessage({ type: 'extension_ui_response_result', id: command.responseId, accepted: true });
  expect(await accepted).toBe(true);
  const retired = f.controller.respond('epoch', { type: 'extension_ui_response', id: 'old', cancelled: true });
  const old = f.responseCommand();
  f.transport.handleMessage({ type: 'extension_ui_state', uiEpoch: 'new', available: true, reset: true });
  expect(await retired).toBe(false);
  f.transport.handleMessage({ type: 'extension_ui_response_result', id: old.responseId, accepted: true });
  expect(f.events.at(-1)).toMatchObject({ type: 'extension_ui_state', uiEpoch: 'new' });
  f.transport.dispose();
});

test('reset and dispose release pending acknowledgements and retire the old controller', async () => {
  const f = fixture();
  const pending = f.controller.respond('epoch', { type: 'extension_ui_response', id: 'dialog', cancelled: true });
  f.transport.reset();
  expect(await pending).toBe(false);
  expect(f.lifecycle.resets).toBe(1);
  const closing = f.controller.respond('epoch', { type: 'extension_ui_response', id: 'next', value: 'text' });
  f.transport.dispose();
  expect(await closing).toBe(false);
  f.transport.dispose();
  f.transport.reset();
  f.controller.setAvailable(false);
  f.controller.setAvailable(true);
  expect(await f.controller.respond('epoch', { type: 'extension_ui_response', id: 'late', value: 'text' })).toBe(false);
  f.transport.handleMessage({ type: 'extension_ui_request', uiEpoch: 'epoch', id: 'late', method: 'notify', message: 'ignored' });
  expect(f.events).toEqual([]);
  expect(f.lifecycle).toEqual({ resets: 1, closes: 1 });
});

test('rejects responses with no responder or no writable worker', async () => {
  const unavailable = fixture(false);
  expect(await unavailable.controller.respond('epoch', { type: 'extension_ui_response', id: 'dialog', cancelled: true })).toBe(false);
  expect(unavailable.commands).toEqual([]);
  unavailable.transport.dispose();
  const unwritable = fixture(true, false);
  expect(await unwritable.controller.respond('epoch', { type: 'extension_ui_response', id: 'dialog', value: '' })).toBe(false);
  unwritable.responseCommand();
  unwritable.transport.dispose();
});

test('bounds a lost worker acknowledgement and ignores its late reply', async () => {
  const f = fixture();
  const pending = f.controller.respond('epoch', { type: 'extension_ui_response', id: 'dialog', value: 'answer' });
  const command = f.responseCommand();
  expect(await pending).toBe(false);
  f.transport.handleMessage({ type: 'extension_ui_response_result', id: command.responseId, accepted: true });
  f.transport.dispose();
}, 7_000);
