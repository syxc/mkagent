import { describe, expect, test } from 'bun:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import * as native from '../src/pi/core/messages.ts';
import * as legacy from '../src/upstream/core/messages.js';
import { deepMergeSettings, isToolModifier } from "@earendil-works/pi-coding-agent";
import { mergeCodingSettings, isToolModifier as legacyToolModifier } from '../src/upstream/core/settings-merge.js';

const fixtureModel: Model<Api> = {
  provider: 'fixture', id: 'local', name: 'Fixture', api: 'openai-completions',
  baseUrl: 'http://unused.invalid', reasoning: false, input: ['text'],
  contextWindow: 4096, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe('shared settings merge', () => {
  test('keeps extension settings and undefined overrides without changing either input', () => {
    const base = { custom: { first: 1, nested: { left: true } }, defaultTools: ['read'] };
    const overrides = { custom: { first: undefined, second: 2, nested: { right: true } }, defaultTools: ['+bash'] };
    expect(mergeCodingSettings(base, overrides)).toEqual({
      custom: { first: 1, second: 2, nested: { left: true, right: true } }, defaultTools: ['read', '+bash'],
    });
    expect(base.custom.nested).toEqual({ left: true });
    expect(overrides.custom.first).toBeUndefined();
  });

  test('shares tool modifier rules and retains replacement and malformed-value semantics', () => {
    expect(legacyToolModifier).toBe(isToolModifier);
    expect(mergeCodingSettings({ defaultTools: ['read'] }, { defaultTools: ['write'] }))
      .toEqual(deepMergeSettings({ defaultTools: ['read'] }, { defaultTools: ['write'] }));
    expect(mergeCodingSettings({ defaultTools: ['read'] }, { defaultTools: 'invalid' }))
      .toEqual({ defaultTools: 'invalid' });
    expect(legacyToolModifier(null)).toBe(false);
  });
});

describe('shared message conversion', () => {
  test('shares summary helpers and their timestamp conversion', () => {
    expect(legacy.bashExecutionToText).toBe(native.bashExecutionToText);
    expect(legacy.createBranchSummaryMessage).toBe(native.createBranchSummaryMessage);
    expect(legacy.createCompactionSummaryMessage).toBe(native.createCompactionSummaryMessage);
    expect(legacy.createCustomMessage).toBe(native.createCustomMessage);
    expect(legacy.createBranchSummaryMessage('branch', 'parent', '2026-01-01T00:00:00Z'))
      .toEqual({ role: 'branchSummary', summary: 'branch', fromId: 'parent', timestamp: 1767225600000 });
  });

  test('preserves legacy metadata and the original object used by projection WeakMaps', () => {
    const message = { role: 'user' as const, content: 'model input', timestamp: 1,
      hostMessageId: 'local-message', hostUserInput: { content: 'display input' } };
    const originals = new WeakMap<object, string>([[message, 'original entry']]);
    const [converted] = legacy.convertToLlm([message]);
    expect(converted).toBe(message);
    expect(originals.get(converted)).toBe('original entry');
    expect(native.convertToLlm([message], { preserveHostMetadata: true })[0]).toBe(message);
    expect(native.convertToLlm([message])).toEqual([{ role: 'user', content: 'model input', timestamp: 1 }]);
    expect(message.hostUserInput.content).toBe('display input');
  });

  test.each(['hostMessageId', 'hostUserInput'])('native conversion strips %s without mutating input', key => {
    const message = { role: 'user' as const, content: 'hello', timestamp: 1, [key]: 'fixture' };
    expect(native.convertToLlm([message])[0]).not.toBe(message);
    expect(native.convertToLlm([message], {})[0]).toEqual({ role: 'user', content: 'hello', timestamp: 1 });
    expect(message[key]).toBe('fixture');
    expect(legacy.convertToLlm([message])[0]).toBe(message);
  });

  test('keeps unannotated standard messages by identity in both entry points', () => {
    const user = { role: 'user' as const, content: 'hello', timestamp: 1 };
    const tool = { role: 'toolResult' as const, toolCallId: 'call', toolName: 'fixture',
      content: [{ type: 'text' as const, text: 'result' }], isError: false, timestamp: 2 };
    for (const convert of [native.convertToLlm, legacy.convertToLlm]) {
      const converted = convert([user, tool]);
      expect(converted[0]).toBe(user);
      expect(converted[1]).toBe(tool);
    }
  });

  test('converts all custom message roles and excludes hidden bash output', () => {
    const bash: native.BashExecutionMessage = {
      role: 'bashExecution', command: 'echo fixture', output: 'fixture', exitCode: 2,
      cancelled: false, truncated: true, fullOutputPath: '/tmp/fixture-output', timestamp: 1,
    };
    const image = { type: 'image' as const, data: 'fixture', mimeType: 'image/png' };
    const custom = native.createCustomMessage('fixture', [image], true, {}, '2026-01-01T00:00:00Z');
    const branch = native.createBranchSummaryMessage('branch', 'parent', '2026-01-01T00:00:00Z');
    const compaction = native.createCompactionSummaryMessage('summary', 40, '2026-01-01T00:00:00Z');
    const input = [bash, { ...bash, excludeFromContext: true }, custom, branch, compaction];
    expect(legacy.convertToLlm(input)).toEqual(native.convertToLlm(input));
    const converted = legacy.convertToLlm(input);
    expect(converted).toHaveLength(4);
    expect(converted[0].content).toEqual([{
      type: 'text', text: 'Ran `echo fixture`\n```\nfixture\n```\n\nCommand exited with code 2'
        + '\n\n[Output truncated. Full output: /tmp/fixture-output]',
    }]);
    expect(converted[1].content).toBe(custom.content);
    expect(converted[2].content).toEqual([
      { type: 'text', text: native.BRANCH_SUMMARY_PREFIX + 'branch' + native.BRANCH_SUMMARY_SUFFIX },
    ]);
    expect(converted[3].content).toEqual([
      { type: 'text', text: native.COMPACTION_SUMMARY_PREFIX + 'summary' + native.COMPACTION_SUMMARY_SUFFIX },
    ]);
    expect(legacy.convertToLlm([native.createCustomMessage('text', 'hello', false, undefined, 'invalid')])[0].content)
      .toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('shared ModelRegistry facade', () => {
  test('uses the published facade with the legacy structural runtime', async () => {
    const { ModelRegistry: NativeRegistry } = await import('@earendil-works/pi-coding-agent');
    const { ModelRegistry: LegacyRegistry } = await import('../src/upstream/core/model-registry.js');
    const model = fixtureModel;
    const models = [model];
    const registry = new LegacyRegistry({
      getModels: () => models, getAvailableSnapshot: () => models,
      getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    });
    expect(registry).toBeInstanceOf(NativeRegistry);
    expect(registry.getAll()).toEqual(models);
    expect(registry.getAll()).not.toBe(models);
    expect(registry.getAvailable()[0]).toBe(model);
    expect(registry.find('fixture', 'local')).toBe(model);
    expect(registry.find('fixture', 'missing')).toBeUndefined();
  });

  test('retains duck-typed legacy auth results and error handling', async () => {
    const { ModelRegistry } = await import('../src/upstream/core/model-registry.js');
    const model = fixtureModel;
    let requireKey = false;
    let failure: Error | undefined;
    const headers = { 'X-Fixture': 'local' };
    const registry = new ModelRegistry({
      getAuth: async () => { if (failure) throw failure; return undefined; },
      getCompatibilityRequestConfig: () => ({ headers, authHeader: requireKey }),
    });
    expect(await registry.getApiKeyAndHeaders(model)).toEqual({ ok: true, headers });
    requireKey = true;
    expect(await registry.getApiKeyAndHeaders(model)).toEqual({ ok: false, error: 'No API key found for "fixture"' });
    failure = new Error('wrapper', { cause: new Error('authHeader requires a resolved API key') });
    expect(await registry.getApiKeyAndHeaders(model)).toEqual({ ok: false, error: 'No API key found for "fixture"' });
    failure = new Error('fixture failure');
    expect(await registry.getApiKeyAndHeaders(model)).toEqual({ ok: false, error: 'fixture failure' });
    expect(await registry.getApiKeyForProvider('fixture')).toBeUndefined();
  });
});
