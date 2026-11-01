import { defineTool, type EntryId, type ToolRegistration } from '@earendil-works/pi-durable';
import { isCanonicalBrowserToolName } from '../../../shared/src/agent/browser-tool-names.ts';
import { BROWSER_INPUT_EVIDENCE, browserInputClassifications } from '../../../shared/src/agent/browser-input-evidence.ts';

export interface ProxyToolResult {
  content: string;
  isError: boolean;
  browserInput?: unknown;
}

export function createProxyTool(
  definition: { name: string; description: string; inputSchema: Record<string, unknown> },
  transport: {
    approve(name: string, args: Record<string, unknown>, callId: string): Promise<Record<string, unknown>>;
    execute(name: string, args: Record<string, unknown>): Promise<ProxyToolResult>;
    prefetched?(callId: string): Promise<ProxyToolResult> | undefined;
  },
): ToolRegistration {
  return defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as never,
    execute: async (args, api, context) => {
      const prefetched = transport.prefetched?.(api.callId);
      const approved = prefetched ? undefined : await transport.approve(definition.name, (args ?? {}) as Record<string, unknown>, api.callId);
      const executedCommand = JSON.stringify(approved?.command);
      const result = prefetched ? await prefetched : await transport.execute(definition.name, approved!);
      if (isCanonicalBrowserToolName(definition.name)) {
        // Bind classifications to the original durable input, before returning or summarizing output.
        await api.commit(async tx => {
          const task = await tx.task(api.taskId);
          const input = task?.input as { kind?: string; call?: { arguments?: { command?: unknown } }; assistant?: EntryId; callId?: string } | undefined;
          const entry = input?.kind === 'model' ? await tx.entry(input.assistant!) : undefined;
          const assistant = entry?.model?.[0];
          const call = input?.kind === 'nested' ? input.call
            : assistant?.role === 'assistant' ? assistant.content.find(item => item.type === 'toolCall' && item.id === input?.callId) : undefined;
          const command = call && 'arguments' in call ? (call.arguments as { command?: unknown }).command : undefined;
          let classifications;
          try {
            classifications = !prefetched && !result.isError && JSON.stringify(command) === executedCommand
              ? browserInputClassifications(result.browserInput, command) : undefined;
          } catch { /* Invalid commands have no safe classification. */ }
          await tx.appendEntry(api.conversationId, {
            kind: BROWSER_INPUT_EVIDENCE,
            data: { version: 1, callId: api.callId, classifications: classifications ?? ['unknown'] },
          });
        }, context);
      }
      return { output: [{ type: 'text' as const, text: result.content }], ...(result.isError ? { isError: true } : {}) };
    },
  });
}
