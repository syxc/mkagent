import { expect, test } from 'bun:test';
import { convertToLlm } from '../src/pi/core/messages.ts';

test('plugin input metadata persists on the native message but never reaches model context', () => {
  const message = { role: 'user' as const, timestamp: 1, content: 'transformed model input',
    hostMessageId: 'native-user-input', hostUserInput: { version: 1, content: 'raw display input' } };
  const converted = convertToLlm([message]);
  expect(converted).toEqual([{ role: 'user', timestamp: 1, content: 'transformed model input' }]);
  expect(message.hostUserInput.content).toBe('raw display input');
  expect(message.hostMessageId).toBe('native-user-input');
});
