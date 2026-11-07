/** Bind the source-ported Pi runner to one durable host, without an Agent loop. */
import type { Api, ImageContent, Model, ModelThinkingLevel as ThinkingLevel, UserMessage } from '@earendil-works/pi-ai';
import { GenerationTask, ToolTask, defineExtension, hook, type Extension, type ToolRegistration, type TaskId, type GenerationHooks, type HookApi, type EntryDraft, type Cursor } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { NativeToolExecutor } from './extension-tools.ts';
import { expandCodingSkill, expandCodingTemplate } from './input.ts';
import { CodingSessionView, type CodingSessionStore } from './session-view.ts';
import type { CodingResources } from './resources.ts';
import { createExtensionRuntime, loadExtensions } from './upstream/core/extensions/loader.js';
import { ExtensionRunner } from './upstream/core/extensions/runner.js';
import type { BuildSystemPromptOptions } from './upstream/core/system-prompt.ts';
import { _buildBoundaryContext, _replaceMessageInPlace } from './upstream/core/boundary-drafts.js';
import { convertToLlm } from './upstream/core/messages.js';

export interface NativeExtensionError {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}

export interface NativeCoreBindings {
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(content: UserMessage['content'], options?: unknown): void;
  getActiveTools(): string[];
  getAllTools(): unknown[];
  getSettings(): unknown;
  setActiveTools(names: string[]): void;
  refreshTools(): void;
  setModel(model: Model<Api>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
}

export interface NativeContextBindings {
  getModel(): Model<Api> | undefined;
  getScopedModels(): unknown[];
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  getSignal(): AbortSignal | undefined;
  abort(): void;
  hasPendingMessages(): boolean;
  getPendingMessages?(): unknown[];
  getPendingCustomMessages?(): unknown[];
  shutdown(): void;
  getContextUsage(): unknown;
  compact(options?: unknown): void;
  getSystemPrompt(): string;
  getSystemPromptOptions(): BuildSystemPromptOptions;
}

export interface NativeRuntimeOptions {
  resources: CodingResources;
  store: CodingSessionStore;
  modelRegistry: object;
  core: NativeCoreBindings;
  context: NativeContextBindings;
  commandActions: Parameters<ExtensionRunner['bindCommandContext']>[0];
  providerActions?: Parameters<ExtensionRunner['bindCore']>[2];
  ui?: Parameters<ExtensionRunner['setUIContext']>[0];
  mode?: 'print' | 'rpc' | 'interactive';
  onError(error: NativeExtensionError): void;
  abortToolTask?(taskId: TaskId, context: Context): Promise<unknown>;
}

export class NativeCodingRuntime {
  readonly session: CodingSessionView;
  readonly runner: ExtensionRunner;
  readonly executor: NativeToolExecutor;
  readonly extension: Extension;
  private readonly startedMessages = new Set<TaskId>();

  private constructor(
    private readonly options: NativeRuntimeOptions,
    loaded: Awaited<ReturnType<typeof loadExtensions>>,
  ) {
    this.session = new CodingSessionView(options.store);
    this.runner = new ExtensionRunner(
      loaded.extensions, loaded.runtime, options.store.cwd, this.session.view, options.modelRegistry,
    );
    this.executor = new NativeToolExecutor(this.runner, options.abortToolTask);
    this.runner.onError(options.onError);
    this.runner.bindCore({
      ...options.core,
      appendEntry: (type: string, data: unknown) => this.session.appendEntry(type, data),
      setSessionName: (name: string) => this.session.setSessionName(name),
      getSessionName: () => this.session.getSessionName(),
      setLabel: (id: string, label?: string) => this.session.setLabel(id, label),
      getCommands: () => this.runner.getRegisteredCommands(),
    }, {
      ...options.context,
      executeTool: this.executor.executeNested,
      getCallableTools: () => options.core.getAllTools(),
    }, options.providerActions);
    this.runner.bindCommandContext(options.commandActions);
    this.runner.setUIContext(options.ui, options.mode ?? 'print');

    this.extension = defineExtension({
      name: 'pi-native-coding-hooks',
      hooks: [
        hook(GenerationTask, {
          ...(loaded.extensions.length ? {
            codingPrepare: (event, api, context) => this.prepare(event, api, context),
          } : {}),
          ...(loaded.extensions.length ? {
            codingBoundary: (boundary, api, context) => this.boundary(boundary, api, context),
          } : {}),
          ...(this.runner.hasHandlers('message_start') || this.runner.hasHandlers('message_update') ? {
            codingStream: (frame: Parameters<GenerationHooks['codingStream']>[0], api: HookApi) => this.streamEvent(frame, api),
          } : {}),
          beforeRequest: request => this.scope(async () => ({
            messages: await this.runner.emitContext(request.messages),
          })),
          beforeProviderRequest: request => this.scope(async () => ({
            payload: await this.runner.emitBeforeProviderRequest(request.payload),
          })),
          afterResponse: (message, api) => this.scope(async () => {
            if (!this.startedMessages.has(api.taskId)) await this.runner.emit({ type: 'message_start', message });
            const replacement = await this.runner.emitMessageEnd({ type: 'message_end', message });
            // afterResponse receives the mutable terminal response before classification.
            if (replacement) _replaceMessageInPlace(message, { ...replacement, content: replacement.content ?? [] });
            this.startedMessages.delete(api.taskId);
          }),
        }),
        hook(ToolTask, {
          beforeTool: (call, api, context) => this.scope(async () => {
            // pi-ai permits readonly arrays; the hook chain edits an owned JSON object.
            const input: Parameters<NativeToolExecutor['executeNested']>[2] = JSON.parse(JSON.stringify(call.arguments));
            const result = await this.runner.emitToolCall({
              type: 'tool_call', toolCallId: call.id, toolName: call.name, input,
              ...(call.parent ? { parentToolCallId: call.parent.callId } : {}),
            });
            await api.memo('pi.native.tool-hook-arguments', input, context);
            return result?.block
              ? { block: result.reason ?? 'Blocked by extension' }
              : { arguments: input };
          }),
          afterTool: (call, result, api, context) => this.scope(async () => {
            const input = await api.memo('mkagent.tool.approved-arguments', context)
              ?? await api.memo('pi.native.tool-hook-arguments', context) ?? call.arguments;
            const changed = await this.runner.emitToolResult({
              type: 'tool_result', toolCallId: call.id, toolName: call.name,
              input, content: result.output ?? [], details: result.details,
              structuredContent: result.structuredOutput, isError: result.isError ?? false,
              usage: result.usage,
              ...(call.parent ? { parentToolCallId: call.parent.callId } : {}),
            });
            if (!changed) return undefined;
            return {
              ...result, output: changed.content, details: changed.details,
              structuredOutput: changed.structuredContent, isError: changed.isError, usage: changed.usage,
            };
          }),
        }),
      ],
    });
  }

  static async load(options: NativeRuntimeOptions): Promise<NativeCodingRuntime> {
    const runtime = createExtensionRuntime();
    const loaded = await loadExtensions(options.resources.extensions, options.store.cwd, undefined, runtime);
    for (const extension of loaded.extensions) {
      const source = options.resources.extensionSources?.get(extension.path);
      if (!source) continue;
      extension.sourceInfo = source;
      for (const command of extension.commands.values()) command.sourceInfo = source;
      for (const tool of extension.tools.values()) tool.sourceInfo = source;
    }
    for (const failure of loaded.errors) {
      options.onError({ extensionPath: failure.path, event: 'load', error: failure.error });
    }
    return new NativeCodingRuntime(options, loaded);
  }

  get tools(): ToolRegistration[] {
    return this.runner.getAllRegisteredTools().map(tool => this.executor.port(tool.definition));
  }

  async start(reason: 'startup' | 'reload' | 'resume' | 'fork' | 'new' = 'startup'): Promise<void> {
    await this.scope(() => this.runner.emit({ type: 'session_start', reason }));
    this.runner.reportUnhandledMcpServers();
  }

  /** Native input ordering: command, input handlers, skill, then template. */
  async input(
    text: string, images?: ImageContent[], source = 'interactive', streamingBehavior?: 'steer' | 'followUp',
    options: { expandPromptTemplates?: boolean } = {},
  ): Promise<{ handled: true } | { handled: false; text: string; images?: ImageContent[] }> {
    return this.scope(async () => {
      const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
      const command = options.expandPromptTemplates !== false && match ? this.runner.getCommand(match[1]) : undefined;
      if (command) {
        await command.handler(match?.[2] ?? '', this.runner.createCommandContext());
        return { handled: true };
      }
      const result = await this.runner.emitInput(text, images, source, streamingBehavior);
      if (result.action === 'handled') return { handled: true };
      const transformed = result.action === 'transform' ? result.text : text;
      const expanded = options.expandPromptTemplates === false ? transformed
        : expandCodingSkill(transformed, this.options.resources, this.options.onError);
      return {
        handled: false,
        text: options.expandPromptTemplates === false ? expanded : expandCodingTemplate(expanded, this.options.resources.prompts),
        images: result.action === 'transform' ? result.images : images,
      };
    });
  }

  async beforeAgentStart(prompt: string, images?: ImageContent[]) {
    return this.scope(() => this.runner.emitBeforeAgentStart(
      { messageType: 'user', prompt, images }, this.options.context.getSystemPromptOptions(),
    ));
  }

  async emit(event: { type: string; [key: string]: unknown }): Promise<void> {
    await this.scope(() => this.runner.emit(event));
  }

  private async prepare(event: Parameters<GenerationHooks['codingPrepare']>[0], api: HookApi, context: Context) {
    const store = this.options.store;
    if (!store.compile) throw new Error('Native preparation requires a durable session store');
    const staged = await this.session.stage(async () => {
      if (event.agentStart) await this.runner.emit({ type: 'agent_start' });
      await this.runner.emit({ type: 'turn_start', turnIndex: event.turnIndex, timestamp: Date.now() });
      const replacements: EntryDraft[] = [];
      const contributions = new Map<string, unknown[]>();
      for (const { sourceEntry, messages } of this.session.preview([]).manager.buildSessionProjection().entries) {
        if (sourceEntry.durableEntryOrder === undefined) continue;
        const key = String(sourceEntry.durableEntryOrder);
        contributions.set(key, [...(contributions.get(key) ?? []), ...messages]);
      }
      let cursor: Cursor | undefined;
      do {
        const page = await api.entries({
          order: 'ascending',
          ...(event.after === undefined && event.first === undefined ? {} : { minEntryId: event.after ?? event.first }),
        }, 512, cursor, context);
        for (const record of page.items) {
          if (event.after !== undefined && record.id <= event.after) continue;
          if (record.head !== undefined && record.kind !== 'pi.reset') continue;
          const original = contributions.get(String(record.id)) ?? [];
          if (!original.some(message => ['user', 'custom'].includes((message as { role: string }).role))) continue;
          const messages = JSON.parse(JSON.stringify(original));
          for (const message of messages) {
            if (message.role !== 'user' && message.role !== 'custom') continue;
            await this.runner.emit({ type: 'message_start', message });
            const replacement = await this.runner.emitMessageEnd({ type: 'message_end', message });
            if (replacement) _replaceMessageInPlace(message, { ...replacement, content: replacement.content ?? [] });
          }
          const model = convertToLlm(messages);
          if (JSON.stringify(model) !== JSON.stringify(convertToLlm(original))) replacements.push({
            kind: 'mkagent.coding.input-edit.v1', edits: [{ target: record.id, action: 'replace', messages: model }],
          });
        }
        cursor = page.next;
      } while (cursor);
      return replacements;
    });
    return { entries: [...store.compile(staged.entries), ...staged.result] };
  }

  private async streamEvent(frame: Parameters<GenerationHooks['codingStream']>[0], api: HookApi): Promise<void> {
    if (frame.type === 'closed') {
      if (frame.aborted) this.startedMessages.delete(api.taskId);
      await this.session.flush();
      return;
    }
    const event = frame.event;
    if (event.type === 'done' || event.type === 'error') return;
    if (!this.startedMessages.has(api.taskId)) {
      await this.runner.emit({ type: 'message_start', message: event.partial });
      this.startedMessages.add(api.taskId);
    }
    if (event.type !== 'start') await this.runner.emit({
      type: 'message_update', message: event.partial, assistantMessageEvent: event,
    });
  }

  private async boundary(
    boundary: Parameters<GenerationHooks['codingBoundary']>[0], api: HookApi, context: Context,
  ) {
    const { store } = this.options;
    if (!store.compile || !store.nativeId) throw new Error('Native boundaries require a durable session store');
    const staged = await this.session.stage(async () => {
      const message = (await api.entry(boundary.assistant, context))?.model?.[0];
      const results = await Promise.all(boundary.results.map(id => api.entry(id, context)));
      const host = {
        _createBoundaryPreviewManager: (drafts: unknown[]) => this.session.preview(drafts).manager,
        _getPendingBoundaryMessages: () => this.options.context.getPendingMessages?.() ?? [],
        _pendingCustomMessages: this.options.context.getPendingCustomMessages?.() ?? [],
        agent: { hasQueuedMessages: () => this.options.context.hasPendingMessages() },
      };
      const preview = (drafts: unknown[]) => Reflect.apply(_buildBoundaryContext, host, [drafts, boundary.type]);
      const result = await this.runner.emitBoundary(boundary.type === 'turn_end' ? {
        type: 'turn_end', turnIndex: boundary.turnIndex, message, outcome: boundary.outcome,
        messageEntryId: store.nativeId!(boundary.assistant),
        toolResults: results.flatMap(entry => entry?.model ?? []),
        toolResultEntryIds: boundary.results.flatMap(id => store.nativeId!(id) ?? []),
      } : { type: 'agent_before_settle', outcome: boundary.outcome }, preview);
      if (result.continue && !preview(result.entries).canContinue) {
        this.runner.emitError({
          extensionPath: '<boundary>', event: boundary.type,
          error: `${boundary.type} continuation requires answerable context or queued input`,
        });
        result.continue = false;
      }
      return { entries: this.session.preview(result.entries).entries, continue: result.continue };
    });
    return { entries: store.compile([...staged.entries, ...staged.result.entries]), continue: staged.result.continue };
  }

  async close(): Promise<void> {
    try {
      await this.emit({ type: 'session_shutdown' });
    } finally {
      this.runner.invalidate();
    }
  }

  private async scope<T>(operation: () => Promise<T>): Promise<T> {
    await this.session.refresh();
    try {
      return await operation();
    } finally {
      await this.session.flush();
    }
  }
}
