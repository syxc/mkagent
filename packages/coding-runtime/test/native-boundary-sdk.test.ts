import { expect, test } from 'bun:test';
import { applySessionBoundaryDrafts, buildSessionBoundaryContext, replaceSessionMessageInPlace, SessionManager } from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';

test('SDK boundary drafts return the original stored entries', () => {
  const manager = SessionManager.inMemory('/tmp/sdk-boundary-fixture');
  const entries = applySessionBoundaryDrafts(manager, [{ type: 'custom', customType: 'fixture', data: { source: 'test' } }]);
  expect(entries).toHaveLength(1);
  expect(manager.getEntry(entries[0]!.id)).toBe(entries[0]);
  expect(entries[0]).toMatchObject({ type: 'custom', customType: 'fixture', data: { source: 'test' } });
});

test('SDK message replacement keeps accepted input identity and rejects forged identity', () => {
  const target = { role: 'user', content: 'before', hostMessageId: 'accepted', hostUserInput: 'original' };
  replaceSessionMessageInPlace(target, {
    role: 'user', content: 'after', hostMessageId: 'forged', hostUserInput: 'forged',
  });
  expect(target).toEqual({ role: 'user', content: 'after', hostMessageId: 'accepted', hostUserInput: 'original' });
  const anonymous = { role: 'user', content: 'before' };
  replaceSessionMessageInPlace(anonymous, { role: 'user', content: 'after', hostMessageId: 'forged', hostUserInput: 'forged' });
  expect(anonymous).toEqual({ role: 'user', content: 'after' });
});

test('SDK boundary previews use the host converter and preserve pending objects', () => {
  const message: Message = { role: 'user', content: 'fixture', timestamp: 1 };
  const converted = [message];
  const pending = [{ hostMessageId: 'pending' }];
  const projection = { entries: [], messages: [] };
  const host = {
    _createBoundaryPreviewManager: () => ({ buildSessionProjection: () => projection }),
    _getPendingBoundaryMessages: () => pending,
    _pendingCustomMessages: [],
    _convertToLlm: () => converted,
    agent: { hasQueuedMessages: () => false },
  };
  const context = buildSessionBoundaryContext.call(host, [], 'turn_end');
  expect(context.contextEntries).toBe(projection.entries);
  expect(context.contextMessages).toBe(projection.messages);
  expect(context.llmMessages).toBe(converted);
  expect(context.pendingMessages).toBe(pending);
  expect(context.canContinue).toBe(true);
});
