import { describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import * as legacy from '../src/upstream/core/context-tokens.js';
import { buildSessionProjection } from '../src/upstream/core/session-manager.js';

function assistant(tokens: number, stopReason: AssistantMessage['stopReason'] = 'stop', text = ''): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions',
    provider: 'fixture', model: 'fixture', stopReason, timestamp: 1,
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

describe('shared context token estimators', () => {
  test('keeps open usage inputs, native totals and component fallback', () => {
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 7 };
    expect(legacy.calculateContextTokens(usage)).toBe(7);
    expect(legacy.calculateContextTokens({ ...usage, totalTokens: 0 })).toBe(10);
    expect(legacy.calculateContextTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  });

  test('uses the last valid usage and estimates trailing messages independently', () => {
    const messages = [
      assistant(10), assistant(999, 'aborted', 'abcdefgh'), assistant(999, 'error'), assistant(0),
      { role: 'user' as const, content: 'abcd', timestamp: 2 },
    ];
    expect(legacy.estimateContextTokens(messages)).toEqual({
      tokens: 13, usageTokens: 10, trailingTokens: 3, lastUsageIndex: 0,
    });
    expect(legacy.estimateContextTokens([messages[4]])).toEqual({
      tokens: 1, usageTokens: 0, trailingTokens: 1, lastUsageIndex: null,
    });
  });

  test('keeps image and system-section heuristics at the old entry point', () => {
    expect(legacy.estimateTokens({ role: 'user', content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' }] }))
      .toBe(1200);
    expect(legacy.estimateTokens({
      role: 'system', content: 'abcd', sections: { first: 'efgh', absent: undefined },
    })).toBe(2);
  });

  test('invalidates old usage after edits or compaction and counts current system sections once', () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const entries = [
      { type: 'message', id: 's1', parentId: null, timestamp,
        message: { role: 'system', content: '', sections: { mode: 'old system contents' }, timestamp: 1 } },
      { type: 'message', id: 's2', parentId: 's1', timestamp,
        message: { role: 'system', content: '', sections: { mode: 'abcd' }, timestamp: 2 } },
      { type: 'message', id: 'u', parentId: 's2', timestamp,
        message: { role: 'user', content: 'abcd', timestamp: 3 } },
      { type: 'message', id: 'a', parentId: 'u', timestamp, message: assistant(100) },
    ];
    expect(legacy.estimateProjectedContextTokens(buildSessionProjection(entries), entries).usageTokens).toBe(100);
    const edited = [...entries, {
      type: 'context_edit', id: 'e', parentId: 'a', timestamp, targetId: 'u',
      replacement: { content: 'abcdefgh' },
    }];
    expect(legacy.estimateProjectedContextTokens(buildSessionProjection(edited), edited)).toEqual({
      tokens: 3, usageTokens: 0, trailingTokens: 3, lastUsageIndex: null,
    });
    const compacted = [...entries, {
      type: 'compaction', id: 'c', parentId: 'a', timestamp,
      summary: '', firstKeptEntryId: 'u', tokensBefore: 100,
      systemMessage: entries[1].message,
    }];
    expect(legacy.estimateProjectedContextTokens(buildSessionProjection(compacted), compacted)).toEqual({
      tokens: 2, usageTokens: 0, trailingTokens: 2, lastUsageIndex: null,
    });
  });
});
