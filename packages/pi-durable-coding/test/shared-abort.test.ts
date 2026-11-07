import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { operationSignal, raceWithAbortSignal } from '../src/pi/utils/abort.ts';

afterEach(() => mock.restore());

test('optional signal preserves the original promise and operation-local signal contract', async () => {
  const operation = Promise.resolve('done');
  expect(raceWithAbortSignal(operation, undefined)).toBe(operation);
  const signal = operationSignal();
  expect(signal.aborted).toBe(false);
  expect(operationSignal()).not.toBe(signal);
  expect(operationSignal(signal)).toBe(signal);
  expect(await operation).toBe('done');
});

test('an already aborted wait preserves its reason and observes later rejection', async () => {
  const controller = new AbortController();
  const reason = { cancelled: 'before waiting' };
  controller.abort(reason);
  const operation = Promise.withResolvers<string>();
  await expect(raceWithAbortSignal(operation.promise, controller.signal)).rejects.toBe(reason);
  operation.reject(new Error('abandoned operation'));
  await Promise.resolve();
});

test('abort while waiting removes its listener and observes later rejection', async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, 'removeEventListener');
  const operation = Promise.withResolvers<string>();
  const pending = raceWithAbortSignal(operation.promise, controller.signal);
  const reason = new Error('cancelled while waiting');
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(remove).toHaveBeenCalledTimes(1);
  operation.reject(new Error('late failure'));
  await Promise.resolve();
});

test('success removes the abort listener and remains settled after cancellation', async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, 'removeEventListener');
  const operation = Promise.withResolvers<string>();
  const pending = raceWithAbortSignal(operation.promise, controller.signal);
  operation.resolve('done');
  expect(await pending).toBe('done');
  expect(remove).toHaveBeenCalledTimes(1);
  controller.abort();
  expect(await pending).toBe('done');
});

test('failure preserves its original reason and removes the abort listener', async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, 'removeEventListener');
  const reason = new Error('operation failed');
  await expect(raceWithAbortSignal(Promise.reject(reason), controller.signal)).rejects.toBe(reason);
  expect(remove).toHaveBeenCalledTimes(1);
});

test('an abort without an exposed reason keeps the coding AbortError fallback', async () => {
  const controller = new AbortController();
  controller.abort();
  Object.defineProperty(controller.signal, 'reason', { value: undefined });
  const pending = raceWithAbortSignal(Promise.resolve('unused'), controller.signal);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'The operation was aborted' });
});
