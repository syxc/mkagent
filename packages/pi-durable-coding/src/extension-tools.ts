/** Native tool definitions execute as durable tasks, including their nested calls. */
import type { Context, JsonValue } from '@earendil-works/chord';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import { LiveDoc, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from '@earendil-works/pi-durable';
import { ExtensionRunner } from './upstream/core/extensions/runner.js';

export interface NativeToolResult {
  content: (TextContent | ImageContent)[];
  details?: JsonValue;
  structuredContent?: JsonValue;
  isError?: boolean;
  usage?: ToolExecutionResult['usage'];
}

/** The runtime portion of Pi's ToolDefinition; renderers stay on the native runner. */
export interface NativeToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: object;
  constrainedSampling?: ToolRegistration['constrainedSampling'];
  executionMode?: ToolRegistration['executionMode'];
  prepareArguments?: (args: unknown) => unknown;
  outputSchema?: object;
  namespace?: unknown;
  annotations?: unknown;
  exposure?: 'direct' | 'deferred' | 'hidden' | 'model-only' | 'codemode';
  execute(
    callId: string, args: unknown, signal: AbortSignal | undefined,
    onUpdate: (result: NativeToolResult) => void,
    context: ReturnType<ExtensionRunner['createToolContext']>,
  ): Promise<NativeToolResult>;
}

interface Invocation {
  api: ToolExecutionApi;
  context: Context;
  nestedCalls: number;
  holdsQueue: boolean;
}

export class NativeToolExecutor {
  private readonly invocations = new Map<string, Invocation>();
  private readonly queuedChildren = new Set<string>();
  private queueTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runner: ExtensionRunner,
    private readonly abortTask?: (taskId: TaskId, context: Context) => Promise<unknown>,
  ) {}

  /** Suitable for ExtensionRunner.bindCore's contextActions.executeTool. */
  readonly executeNested = async (
    parentCallId: string, name: string, args: Parameters<ToolExecutionApi['executeTool']>[1],
    options: { signal?: AbortSignal; onUpdate?: (result: NativeToolResult) => void } = {},
  ) => {
    const invocation = this.invocations.get(parentCallId);
    if (!invocation) throw new Error(`Tool invocation is no longer active: ${parentCallId}`);
    const tool = this.runner.getToolDefinition(name);
    if ((options.signal || options.onUpdate) && !this.abortTask) {
      throw new Error('Native nested cancellation and progress require the host abortTask binding');
    }
    // Match Pi's exclusive queue, including reentry from a tool holding it.
    const exclusive = !invocation.holdsQueue && tool?.executionMode === 'sequential';
    let release: (() => void) | undefined;
    if (exclusive) {
      const previous = this.queueTail;
      this.queueTail = new Promise(resolve => { release = resolve; });
      await previous;
    }
    let nested: Awaited<ReturnType<ToolExecutionApi['executeTool']>>;
    let callId: string;
    try {
      options.signal?.throwIfAborted();
      invocation.context.abortSignal?.throwIfAborted();
      callId = `${parentCallId}/${++invocation.nestedCalls}`;
      if (exclusive || invocation.holdsQueue) this.queuedChildren.add(callId);
      nested = await this.runNested(invocation, callId, name, args, options);
    } finally {
      release?.();
    }
    const content = tool?.outputSchema
      ? [{ type: 'text' as const, text: JSON.stringify(nested.structuredOutput ?? null) }]
      : modelContent(nested.structuredOutput);
    for (const diagnostic of nested.diagnostics) {
      if (diagnostic.severity === 'error') content.push({ type: 'text', text: diagnostic.message });
    }
    return {
      toolCall: { type: 'toolCall' as const, id: callId, name, arguments: args },
      result: {
        content, details: nested.details,
        ...(tool?.outputSchema ? { structuredContent: nested.structuredOutput } : {}),
      },
      isError: nested.isError,
      // Durable already records nested usage. Returning it here would count it twice.
    };
  };

  private async runNested(
    invocation: Invocation, callId: string, name: string,
    args: Parameters<ToolExecutionApi['executeTool']>[1],
    options: { signal?: AbortSignal; onUpdate?: (result: NativeToolResult) => void },
  ): Promise<Awaited<ReturnType<ToolExecutionApi['executeTool']>>> {
    let taskId: TaskId | undefined;
    let cancellation: Promise<unknown> | undefined;
    let callbackFailure: unknown;
    let callbackFailed = false;
    let lastProgress: string | undefined;
    const cancel = () => {
      if (!taskId || cancellation || !this.abortTask) return;
      cancellation = this.abortTask(taskId, invocation.context);
      void cancellation.catch(() => {});
    };
    // Admission allocates durable's ordinal synchronously, before the watch awaits.
    const execution = invocation.api.executeTool(name, args, invocation.context);
    void execution.catch(() => {});
    const watch = options.signal || options.onUpdate
      ? await invocation.api.watchDoc(LiveDoc, invocation.api.conversationId, invocation.context) : undefined;
    watch?.start(async call => {
      if (call.kind !== 'value') return;
      const value = call.value;
      const slot = value?.nestedTools?.find(item => item.callId === callId && item.parentTaskId === invocation.api.taskId);
      if (!slot) return;
      taskId = slot.taskId;
      if (options.signal?.aborted) cancel();
      if (slot.status !== 'running' || !options.onUpdate) return;
      const progress = JSON.stringify([slot.output, slot.details]);
      if (lastProgress === progress) return;
      lastProgress = progress;
      try {
        options.onUpdate({ content: modelContent(slot.output), details: slot.details });
      } catch (error) {
        callbackFailure = error;
        callbackFailed = true;
        cancel();
      }
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      // Keep waiting after a caller cancels, until the child actually stops.
      const result = await execution;
      await cancellation;
      if (callbackFailed) throw callbackFailure;
      return result;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      await watch?.stop();
      this.queuedChildren.delete(callId);
    }
  }

  /** The caller must apply the host permission wrapper before installing this tool. */
  port(definition: NativeToolDefinition): ToolRegistration & { namespace?: unknown; annotations?: unknown } {
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      constrainedSampling: definition.constrainedSampling,
      executionMode: definition.executionMode,
      prepareArguments: definition.prepareArguments,
      structuredOutputSchema: definition.outputSchema,
      namespace: definition.namespace,
      annotations: definition.annotations,
      ...(definition.exposure === 'deferred' ? { deferred: true as const } : {}),
      ...(definition.exposure === 'hidden' ? { callers: [] as const } : {}),
      ...(definition.exposure === 'codemode' ? { callers: ['tools'] as const } : {}),
      ...(definition.exposure === 'model-only' ? { callers: ['model'] as const } : {}),
      replay: 'unsafe',
      execute: async (args, api, context) => {
        const updates: Promise<void>[] = [];
        let previous = '';
        this.invocations.set(api.callId, {
          api, context, nestedCalls: 0, holdsQueue: this.queuedChildren.has(api.callId),
        });
        try {
          const result = await definition.execute(
            api.callId, args, context.abortSignal,
            update => {
              const text = update.content.filter(part => part.type === 'text').map(part => part.text).join('');
              if (text.startsWith(previous)) {
                api.output(text.slice(previous.length));
                previous = text;
              }
              if (update.details !== undefined) {
                const pending = api.details(update.details, context);
                // A native callback cannot await this commit. Join it before settling.
                void pending.catch(() => {});
                updates.push(pending);
              }
            },
            this.runner.createToolContext(api.callId, context.abortSignal),
          );
          await Promise.all(updates);
          return {
            output: result.content, details: result.details, isError: result.isError,
            ...(definition.outputSchema ? { structuredOutput: result.structuredContent } : {}),
            usage: result.usage,
          };
        } finally {
          this.invocations.delete(api.callId);
          await Promise.allSettled(updates);
        }
      },
    };
  }
}

function modelContent(value: JsonValue | undefined): (TextContent | ImageContent)[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (Array.isArray(value) && value.every(isContent)) return value;
  if (isContent(value)) return [value];
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function isContent(value: unknown): value is (TextContent | ImageContent) & JsonValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'type' in value && ((value.type === 'text' && 'text' in value && typeof value.text === 'string')
      || (value.type === 'image' && 'data' in value && typeof value.data === 'string'
        && 'mimeType' in value && typeof value.mimeType === 'string'));
}
