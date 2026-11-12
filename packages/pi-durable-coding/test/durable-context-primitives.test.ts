import { expect, test } from 'bun:test';
import { contribute, findBaseline, leadWithSystem, orderToolResults } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';

test('public SDK context primitives keep message identity and frozen contributions', () => {
  const user: Message = { role: 'user', content: 'fixture', timestamp: 1 };
  const system: Message = { role: 'system', content: 'fixture', timestamp: 1 };
  const contribution = contribute({ model: [user] }, undefined);
  expect(contribution[0]).toBe(user);
  expect(Object.isFrozen(contribution)).toBe(true);
  expect(findBaseline(undefined, [])).toBeUndefined();
  const messages = [system, user];
  expect(leadWithSystem(messages, system)).toBe(messages);
  expect(leadWithSystem([user, system], system)).toEqual(messages);
  expect(orderToolResults(contribution)).toEqual([user]);
});
