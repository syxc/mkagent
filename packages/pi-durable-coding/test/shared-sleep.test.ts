import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { sleep } from '../src/pi/utils/sleep.ts';

afterEach(() => mock.restore());

test('sleep accepts an omitted signal and resolves without a value', async () => {
  expect(await sleep(0)).toBeUndefined();
});

test('a completed wait releases its abort listener and survives later cancellation', async () => {
  const controller = new AbortController();
  const remove = spyOn(controller.signal, 'removeEventListener');
  const pending = sleep(0, controller.signal);
  expect(await pending).toBeUndefined();
  expect(remove).toHaveBeenCalledTimes(1);
  controller.abort(new Error('too late'));
  expect(await pending).toBeUndefined();
});

test('an already cancelled wait preserves the coding error for every abort reason', async () => {
  for (const reason of [undefined, 'cancelled', { cancelled: true }, new Error('custom reason'), NaN]) {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(sleep(60_000, controller.signal)).rejects.toMatchObject({
      name: 'Error',
      message: 'Aborted',
    });
  }
});

test('cancelling an active wait uses the coding error instead of the signal reason', async () => {
  for (const reason of [{ cancelled: 'during the wait' }, NaN]) {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ name: 'Error', message: 'Aborted' });
    await expect(pending).rejects.not.toBe(reason);
  }
});

test('non-cancellation timer errors retain their identity', async () => {
  const reason = new Error('delay conversion failed');
  const delay = { valueOf: () => { throw reason; } };
  const controller = new AbortController();
  await expect(Reflect.apply(sleep, undefined, [delay, controller.signal])).rejects.toBe(reason);
});
