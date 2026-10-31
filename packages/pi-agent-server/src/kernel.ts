/**
 * Durable kernel session lifecycle.
 *
 * Owns the `Harness`, the root conversation, and the mapping from durable
 * `watchEvents` batches to the pi-coding-agent 1.1.0 `AgentSessionEvent` shapes
 * the host's `PiEventAdapter` already consumes. Storage lives at
 * `<sessionPath>/durable-store/`; a legacy `<sessionPath>/.pi-sessions/`
 * transcript is converted once by `migrate.ts` before the store opens, and
 * `id-map.json` records old → new entry ids for branch anchors.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_COMPACTION_POLICY,
  Harness,
  createRegistry,
  defineExtension,
  section,
  watchEvents,
  type AgentEvent,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type HarnessSettings,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { openDurableStorage } from './storage/durable-storage.ts';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { AssistantMessage, Models, ToolCall } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { migrateParentStore, migrateLegacySession, readEntryIdMap } from './migrate.ts';
import { compactionReserveFor } from './compaction-reserve.ts';

/**
 * Main-chat retry/stream policy, mirroring the old 1.1.0 main-chat settings
 * (utility sessions use their own retry loop in `ephemeral.ts`).
 */
const MAIN_RETRY = {
  enabled: true,
  maxRetries: 4,
  baseDelayMs: 2_000,
  maxAgentDelayMs: 60_000,
  streamMaxRetries: 2,
  streamMaxRetryDelayMs: 60_000,
} as const;

/** Host-visible model identity plus the contextWindow the UI and reserves need. */
export interface KernelModelRef {
  provider: string;
  modelId: string;
  contextWindow?: number;
}

export interface KernelHooks {
  emitEvent(sessionEvent: AgentSessionEvent | Record<string, unknown>): void;
  sessionToolCompleted(toolName: string, args: Record<string, unknown>, isError: boolean): void;
  /** Speculative parallel prefetch for repeated proxy tool calls. */
  prefetchToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void;
  isPrefetchableTool(toolName: string): boolean;
  debugLog(message: string): void;
}

export interface DurableKernelOptions {
  sessionPath: string;
  cwd: string;
  /** MKAGENT_GIT_BASH_PATH override for the shell environment. */
  shellPath?: string;
  /** Compact once context reaches this many tokens (config.json autoCompactWindow). */
  autoCompactWindow?: number;
  /** Current pi-ai `Models`; read at each use so re-init can swap it live. */
  modelsSource(): Models;
  hooks: KernelHooks;
  /** Tools extension installed on the registry (wrapped builtin + session + MCP tools). */
  toolsExtension: Extension;
}

export interface KernelOpenOptions {
  model?: KernelModelRef;
  thinkingLevel?: string;
  branchFromSessionPath?: string;
  /** Old pi entry id of the branch anchor; translated through the id map. */
  branchFromSdkTurnId?: string;
}

interface RetrySynthState {
  /** A retry backoff is scheduled; the retried attempt has not started. */
  pending: boolean;
  /** The retried attempt is streaming. */
  active: boolean;
  attempt: number;
  errorMessage: string | undefined;
}

export class DurableKernel {
  /** Active model for context-window tracking and compaction reserves. */
  currentModel: KernelModelRef | undefined;
  /** Craft system prompt for the next request; sections render at preparation. */
  systemPrompt: string | undefined;
  /** Stable session id surfaced to the host; assigned in open(). */
  sessionId = '';
  /** True between run_start and run_end. */
  busy = false;
  private autoCompactionEnabled = true;

  private harness: Harness | null = null;
  private conversation: Conversation | null = null;
  private readonly options: DurableKernelOptions;
  private detachWatch: (() => void) | null = null;
  private readonly retry: RetrySynthState = { pending: false, active: false, attempt: 0, errorMessage: undefined };
  private lastUsage: { totalTokens: number } | undefined;
  /** In-flight assistant partial (message_start → message_end). */
  private partial: AssistantMessage | undefined;
  /** Final assistant message of the most recent turn. */
  private lastAssistant: AssistantMessage | undefined;
  /** session__ tool calls awaiting their result to report completion. */
  private pendingSessionTools = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  /** Retained output window per running tool call (append/trimStart semantics). */
  private toolOutputBuffers = new Map<string, string>();

  constructor(options: DurableKernelOptions) {
    this.options = options;
  }

  private get storeDir(): string {
    return join(this.options.sessionPath, 'durable-store');
  }

  /**
   * Open (or resume) the durable store. Order matters: the branch copy runs
   * before the store opens, and the legacy migration needs the open Harness.
   */
  async open(config: KernelOpenOptions): Promise<void> {
    const branchFrom = config.branchFromSessionPath;
    if (branchFrom) {
      // A parent that has never opened under this kernel gets its legacy
      // transcript converted in place first, so the copy carries full context.
      await migrateParentStore(branchFrom, this.options.hooks.debugLog);
      const parentStore = join(branchFrom, 'durable-store');
      if (!existsSync(parentStore) || !existsSync(join(parentStore, 'id-map.json'))) {
        throw new Error(`Pi branch preflight failed: no parent session transcript found in ${branchFrom}`);
      }
      if (!existsSync(this.storeDir)) {
        mkdirSync(this.options.sessionPath, { recursive: true });
        cpSync(parentStore, this.storeDir, { recursive: true });
      }
    }

    await this.openStore();

    // Idempotent: a store that already has entries (resume, or a branch copy)
    // is left untouched. The converted legacy entries and the last stored
    // model/thinking level feed the defaults below.
    const legacy = await migrateLegacySession(this.harness!, this.options.sessionPath, this.options.hooks.debugLog);

    // Branch cutoff: fork the copied conversation at the anchor entry, dropping
    // everything after it. Without an anchor the copied conversation continues
    // as-is (old continueRecent behavior). Branches must not silently degrade
    // to fresh sessions, so an unresolvable anchor is a hard error.
    if (branchFrom) {
      const anchor = config.branchFromSdkTurnId ? this.resolveBranchAnchor(config.branchFromSdkTurnId) : undefined;
      if (config.branchFromSdkTurnId && anchor === undefined) {
        throw new Error(`Pi branch preflight failed: branch anchor not found: ${config.branchFromSdkTurnId}`);
      }
      if (anchor !== undefined && this.conversation) {
        const forked = await this.conversation.fork(anchor, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
        this.conversation = forked;
        await this.attachWatch(forked.id);
        this.options.hooks.debugLog(`Applied branch cutoff at durable entry ${anchor}`);
      }
    }

    this.sessionId = this.loadOrCreateSessionId();
    const model = config.model ?? legacy?.model;
    const thinkingLevel = config.thinkingLevel ?? legacy?.thinkingLevel;
    if (model) this.currentModel = model;
    if (model || thinkingLevel) {
      // Re-assert on resume, or after a fork copied the parent's agent doc.
      await this.conversation?.configure(
        {
          ...(model ? { model: { provider: model.provider, modelId: model.modelId } } : {}),
          ...(thinkingLevel ? { thinkingLevel: thinkingLevel as never } : {}),
        },
        BACKGROUND_CONTEXT,
      );
    }
  }

  /**
   * Branch anchor from the host: either a pre-migration pi entry id (through
   * the id map) or a durable entry id recorded in a `pi_turn_anchor` event
   * (numeric string). Returns undefined when unresolvable.
   */
  private resolveBranchAnchor(raw: string): EntryId | undefined {
    const mapped = readEntryIdMap(this.storeDir)?.get(raw);
    if (mapped !== undefined) return mapped;
    const numeric = Number(raw);
    return Number.isSafeInteger(numeric) && String(numeric) === raw ? (numeric as EntryId) : undefined;
  }

  /** Attach the event synthesizer to a conversation's watch stream. */
  private async attachWatch(conversationId: ConversationId): Promise<void> {
    const stream = await watchEvents(this.harness!, conversationId, BACKGROUND_CONTEXT);
    stream.start(async events => {
      for (const event of events) {
        for (const synthesized of this.synthesizeEvent(event)) {
          this.options.hooks.emitEvent(synthesized);
        }
      }
    });
    this.detachWatch = () => {
      void stream.stop();
    };
  }

  private async openStore(): Promise<void> {
    const storage = await openDurableStorage(this.storeDir, BACKGROUND_CONTEXT);

    const registry = createRegistry<ToolRegistration>();

    // Craft replaces the entire system prompt: tag:false keeps the text
    // verbatim, and no other extension contributes sections.
    registry.install(defineExtension({
      name: 'mkagent-system-prompt',
      sections: [section('mkagent-system-prompt', () => this.systemPrompt, { tag: false })],
    }));
    registry.install(this.options.toolsExtension);

    this.harness = await Harness.open(storage, {
      models: () => this.options.modelsSource(),
      registry,
      settings: () => this.buildSettings(),
      env: target => new NodeExecutionEnv({
        cwd: target.cwd ?? this.options.cwd,
        ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
      }),
      onReport: (error, info) => {
        this.options.hooks.debugLog(`[kernel] ${info?.type ?? 'report'}: ${error instanceof Error ? error.message : String(error)}`);
      },
    }, BACKGROUND_CONTEXT);
    this.harness.resume();

    this.conversation = await this.harness.root(BACKGROUND_CONTEXT, {
      agent: this.currentModel
        ? { model: { provider: this.currentModel.provider, modelId: this.currentModel.modelId } }
        : undefined,
    });
    await this.attachWatch(this.conversation.id);
  }

  private buildSettings(): HarnessSettings {
    const model = this.currentModel;
    const modelOverrides = model?.contextWindow
      ? {
          [`${model.provider}/${model.modelId}`]: {
            // Craft's "Compact context at" becomes a per-model reserve.
            reserveTokens: compactionReserveFor(model.contextWindow, DEFAULT_COMPACTION_POLICY.reserveTokens, this.options.autoCompactWindow),
          },
        }
      : undefined;
    return {
      stream: {
        maxRetries: MAIN_RETRY.streamMaxRetries,
        maxRetryDelayMs: MAIN_RETRY.streamMaxRetryDelayMs,
      },
      retry: {
        enabled: MAIN_RETRY.enabled,
        maxRetries: MAIN_RETRY.maxRetries,
        baseDelayMs: MAIN_RETRY.baseDelayMs,
        maxAgentDelayMs: MAIN_RETRY.maxAgentDelayMs,
      },
      compaction: {
        enabled: this.autoCompactionEnabled,
        modelOverrides,
      },
      // Deliver every queued steer at a turn boundary in one model call.
      steeringMode: 'all',
    };
  }

  /**
   * Stable per-sessionPath id, mirroring how pi session files kept their id.
   * Created after the branch copy so a branched child never inherits its
   * parent's marker.
   */
  private loadOrCreateSessionId(): string {
    const marker = join(this.storeDir, 'session-id.txt');
    try {
      const existing = readFileSync(marker, 'utf-8').trim();
      if (existing) return existing;
    } catch { /* first run */ }
    const id = randomUUID();
    try {
      writeFileSync(marker, id);
    } catch { /* read-only session dir: id just won't persist */ }
    return id;
  }

  // ============================================================
  // Conversation commands
  // ============================================================

  async submitPrompt(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    if (!this.conversation) throw new Error('Kernel not open');
    const content = images && images.length > 0
      ? [{ type: 'text' as const, text: message }, ...images.map(img => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))]
      : message;
    await this.conversation.submit({ type: 'input', content, whenBusy: 'followUp' }, BACKGROUND_CONTEXT);
  }

  async steer(message: string): Promise<void> {
    if (!this.conversation) throw new Error('Kernel not open');
    await this.conversation.submit({ type: 'input', content: message, whenBusy: 'steer' }, BACKGROUND_CONTEXT);
  }

  async abort(): Promise<void> {
    if (!this.conversation) return;
    await this.conversation.abort(BACKGROUND_CONTEXT);
  }

  async setModel(model: KernelModelRef): Promise<void> {
    this.currentModel = model;
    await this.conversation?.configure({ model: { provider: model.provider, modelId: model.modelId } }, BACKGROUND_CONTEXT);
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.conversation?.configure({ thinkingLevel: level as never }, BACKGROUND_CONTEXT);
  }

  setAutoCompaction(enabled: boolean): void {
    this.autoCompactionEnabled = enabled;
  }

  getAutoCompactionEnabled(): boolean {
    return this.autoCompactionEnabled;
  }

  /**
   * Manual compaction, resolved in the host's PiCompactResult shape. Durable's
   * receipt carries no token estimate, so tracked usage stands in for
   * tokensBefore/estimatedTokensAfter (known difference: can be stale).
   */
  async compact(customInstructions?: string): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter: number;
  }> {
    if (!this.conversation || !this.harness) throw new Error('Kernel not open');
    const before = await this.getLatestEntryId();
    const taskId = await this.conversation.compact(customInstructions, BACKGROUND_CONTEXT);
    await this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    const after = await this.getLatestEntryId();
    const tokens = this.lastUsage?.totalTokens ?? 0;
    const entry = after && after !== before ? await this.getEntry(after) : undefined;
    // The compaction entry holds the wrapped summary as a user message; its
    // head is the first entry kept in the new context.
    const message = entry?.kind === 'pi.compaction' ? entry.model?.[0] : undefined;
    const summary = message?.role === 'user'
      ? (typeof message.content === 'string'
        ? message.content
        : message.content.filter(c => c.type === 'text').map(c => c.text).join(''))
      : '';
    return {
      summary,
      firstKeptEntryId: entry?.head !== undefined ? String(entry.head) : '',
      tokensBefore: tokens,
      estimatedTokensAfter: tokens,
    };
  }

  async getLatestEntryId(): Promise<EntryId | undefined> {
    if (!this.conversation) return undefined;
    const page = await this.conversation.entries({ order: 'descending' }, 1, undefined, BACKGROUND_CONTEXT);
    return page.items[0]?.id;
  }

  /** Read one entry by id through the conversation's fork-aware history. */
  async getEntry(entryId: EntryId): Promise<EntryRecord | undefined> {
    if (!this.conversation) return undefined;
    const page = await this.conversation.entries(
      { maxEntryId: entryId, order: 'descending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );
    return page.items[0];
  }

  async close(): Promise<void> {
    this.detachWatch?.();
    this.detachWatch = null;
    if (this.harness) {
      await this.harness.close(BACKGROUND_CONTEXT);
      this.harness = null;
    }
    this.conversation = null;
  }

  // ============================================================
  // Context usage payload (PiContextUsagePayload contract)
  // ============================================================

  /** Attached to outbound events; the adapter reads it on every event type. */
  contextUsagePayload(): {
    contextUsage?: { tokens: number | null; contextWindow: number; percent?: number };
    compactionSettings?: { enabled: boolean; reserveTokens: number };
  } {
    const payload: {
      contextUsage?: { tokens: number | null; contextWindow: number; percent?: number };
      compactionSettings?: { enabled: boolean; reserveTokens: number };
    } = {
      compactionSettings: {
        enabled: this.autoCompactionEnabled,
        reserveTokens: compactionReserveFor(
          this.currentModel?.contextWindow,
          DEFAULT_COMPACTION_POLICY.reserveTokens,
          this.options.autoCompactWindow,
        ),
      },
    };
    const usage = this.lastUsage;
    const contextWindow = this.currentModel?.contextWindow;
    if (usage && contextWindow) {
      payload.contextUsage = {
        tokens: usage.totalTokens,
        contextWindow,
        percent: Math.round((usage.totalTokens / contextWindow) * 100),
      };
    }
    return payload;
  }

  // ============================================================
  // Event synthesis: durable AgentEvent → AgentSessionEvent
  // ============================================================

  private synthesizeEvent(event: AgentEvent): (AgentSessionEvent | Record<string, unknown>)[] {
    switch (event.type) {
      case 'snapshot':
      case 'inbox_update':
      case 'submission':
      case 'deferred_poll':
      case 'agent_changed':
      case 'usage_changed':
      case 'task_failed':
      case 'entry_appended':
        return [];

      case 'run_start':
        this.busy = true;
        return [{ type: 'agent_start' }];

      case 'run_end': {
        this.busy = false;
        // Retry cancelled or the last attempt failed: no recovered assistant
        // message follows, so end the retry and finalize. agent_end first —
        // with a parked error (recovering) it releases and completes; with a
        // live backoff it only opens the queue, which the trailing
        // auto_retry_end then releases.
        const out: (AgentSessionEvent | Record<string, unknown>)[] = [{ type: 'agent_end', messages: [], willRetry: false }];
        if (this.retry.pending || this.retry.active) {
          out.push({
            type: 'auto_retry_end',
            success: false,
            attempt: this.retry.attempt,
            ...(this.retry.errorMessage ? { finalError: this.retry.errorMessage } : {}),
          });
        }
        this.retry.pending = false;
        this.retry.active = false;
        return out;
      }

      case 'turn_start': {
        // A retried attempt re-streams under a new turn; the old flow announced
        // it with agent_start (backoff → recovering) before turn_start.
        if (this.retry.pending) {
          this.retry.pending = false;
          this.retry.active = true;
          return [{ type: 'agent_start' }, { type: 'turn_start' }];
        }
        return [{ type: 'turn_start' }];
      }

      case 'message_start': {
        const message = event.message;
        if (message.role !== 'assistant') return [];
        this.partial = message;
        const out: (AgentSessionEvent | Record<string, unknown>)[] = [];
        if (this.retry.pending) {
          this.retry.pending = false;
          this.retry.active = true;
          out.push({ type: 'agent_start' });
        }
        // partialIntervalMs (default 100ms) folds the stream's opening deltas
        // into the first observed partial. The 1.1.0 SDK announced
        // message_start with an empty partial and surfaced that content as
        // deltas — a one-chunk stream would otherwise never produce a
        // text_delta — so re-derive them here.
        out.push({ type: 'message_start', message: { ...message, content: [] } });
        out.push(...initialMessageDeltas(message));
        return out;
      }

      case 'message_update': {
        if (event.usage) this.lastUsage = event.usage;
        const out: (AgentSessionEvent | Record<string, unknown>)[] = [];
        for (const change of event.changes) {
          if (change.type === 'text_delta' || change.type === 'thinking_delta') {
            // The host adapter reads only the assistant event's `type` and
            // `delta`; `contentIndex`/`partial` ride along for shape parity.
            out.push({
              type: 'message_update',
              // message_update only fires between message_start and message_end.
              message: this.partial!,
              assistantMessageEvent: {
                type: change.type,
                contentIndex: change.contentIndex,
                delta: change.delta,
                partial: this.partial as AssistantMessage,
              },
            });
          }
        }
        return out;
      }

      case 'message_end': {
        const message = event.entry.model?.[0];
        if (!message || message.role === 'system') return [];
        if (message.role !== 'assistant') {
          return [{ type: 'message_end', message }];
        }
        if (message.usage) this.lastUsage = message.usage;
        this.lastAssistant = message;
        this.partial = undefined;

        const out: (AgentSessionEvent | Record<string, unknown>)[] = [{ type: 'message_end', message }];

        // The durable entry id is committed with the message, so the anchor is
        // synchronous here — no microtask race like the 1.1.0 leafId read.
        const sdkMessageId = (message as { id?: string }).id ?? randomUUID();
        out.push({ type: 'pi_turn_anchor', sdkMessageId, sdkTurnAnchor: event.entry.id });

        // Speculative prefetch: 2+ prefetchable tool calls in one message fire
        // in parallel before the (possibly sequential) tool round starts.
        const toolCalls = message.content.filter(c => c.type === 'toolCall') as ToolCall[];
        const prefetchable = toolCalls.filter(tc => this.options.hooks.isPrefetchableTool(tc.name));
        if (prefetchable.length >= 2) {
          for (const tc of prefetchable) {
            this.options.hooks.prefetchToolCall(tc.id, tc.name, (tc.arguments ?? {}) as Record<string, unknown>);
          }
        }

        // Retry recovered: announce success before the run's agent_end.
        if (this.retry.active && message.stopReason !== 'error') {
          this.retry.active = false;
          out.push({ type: 'auto_retry_end', success: true, attempt: this.retry.attempt });
        }

        out.push({ type: 'context_usage', ...this.contextUsagePayload() });
        return out;
      }

      case 'turn_end':
        return [{
          type: 'turn_end',
          // A turn_end follows this run's assistant message_end.
          message: this.lastAssistant!,
          toolResults: [],
          ...this.contextUsagePayload(),
        }];

      case 'tool_execution_start': {
        const args = (event.args ?? {}) as Record<string, unknown>;
        if (event.toolName.startsWith('session__')) {
          this.pendingSessionTools.set(event.toolCallId, {
            toolName: event.toolName.replace(/^session__/, ''),
            args,
          });
        }
        const out: Record<string, unknown> = {
          type: 'tool_execution_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args,
        };
        if (event.parentToolCallId) out.parentToolCallId = event.parentToolCallId;
        // MkAgent UI metadata rides on the args; the interceptor strips it
        // before the tool implementation sees them.
        const toolMetadata: Record<string, unknown> = { source: 'interceptor' };
        if (typeof args._intent === 'string') toolMetadata.intent = args._intent;
        if (typeof args._displayName === 'string') toolMetadata.displayName = args._displayName;
        if (toolMetadata.intent || toolMetadata.displayName) out.toolMetadata = toolMetadata;
        this.toolOutputBuffers.set(event.toolCallId, '');
        return [out];
      }

      case 'tool_execution_update': {
        const output = event.output;
        if (output === undefined) return [];
        let text: string;
        if ('set' in output) {
          text = output.set;
        } else {
          const previous = this.toolOutputBuffers.get(event.toolCallId) ?? '';
          // Front trim then append: the retained window slid forward.
          text = previous.slice(output.trimStart ?? 0) + (output.append ?? '');
        }
        this.toolOutputBuffers.set(event.toolCallId, text);
        const out: Record<string, unknown> = {
          type: 'tool_execution_update',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: {},
          partialResult: { content: [{ type: 'text', text }] },
        };
        if (event.parentToolCallId) out.parentToolCallId = event.parentToolCallId;
        return [out];
      }

      case 'tool_execution_end': {
        const toolResult = event.entry?.model?.[0];
        let result: unknown;
        let isError = false;
        if (toolResult && toolResult.role === 'toolResult') {
          result = { content: toolResult.content, isError: toolResult.isError };
          isError = toolResult.isError ?? false;
        } else if (event.result) {
          // Nested call: no transcript entry; surface its structured output.
          const structured = event.result.structuredOutput;
          const text = typeof structured === 'string'
            ? structured
            : structured === undefined ? '' : JSON.stringify(structured);
          result = { content: [{ type: 'text', text }] };
          isError = event.result.isError;
        } else {
          // Faulted or orphaned call: its slot left the live view unfinished.
          result = { content: [{ type: 'text', text: '' }] };
        }
        this.toolOutputBuffers.delete(event.toolCallId);

        const pending = this.pendingSessionTools.get(event.toolCallId);
        if (pending) {
          this.pendingSessionTools.delete(event.toolCallId);
          this.options.hooks.sessionToolCompleted(pending.toolName, pending.args, isError);
        }

        const out: Record<string, unknown> = {
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result,
          isError,
        };
        if (event.parentToolCallId) out.parentToolCallId = event.parentToolCallId;
        return [out];
      }

      case 'compaction_start':
        return [{
          type: 'compaction_start',
          reason: event.reason,
          ...this.contextUsagePayload(),
        }];

      case 'compaction_end': {
        // `result` truthiness drives the adapter's success path. Durable's
        // receipt has no token estimate, so tracked usage stands in (known
        // difference: the estimate can be stale).
        const tokens = this.lastUsage?.totalTokens ?? 0;
        const result = event.error
          ? undefined
          : { summary: '', firstKeptEntryId: '', tokensBefore: tokens, estimatedTokensAfter: tokens };
        return [{
          type: 'compaction_end',
          reason: event.reason,
          result,
          aborted: false,
          willRetry: false,
          ...(event.error ? { errorMessage: event.error } : {}),
        }];
      }

      case 'auto_retry_start': {
        // Old flow: agent_end { willRetry: true } precedes auto_retry_start.
        this.retry.pending = true;
        this.retry.active = false;
        this.retry.attempt = event.attempt;
        this.retry.errorMessage = event.errorMessage;
        return [
          { type: 'agent_end', messages: [], willRetry: true },
          {
            type: 'auto_retry_start',
            attempt: event.attempt,
            maxAttempts: MAIN_RETRY.maxRetries,
            delayMs: Math.max(0, event.at - Date.now()),
            errorMessage: event.errorMessage,
          },
        ];
      }

      // Retry success and cancellation are both synthesized elsewhere: success
      // at the recovered message_end, cancellation at run_end.
      case 'auto_retry_end':
        return [];

      default:
        return [];
    }
  }
}

/**
 * message_update events for text/thinking content a partial already carries
 * (the stream's opening deltas, folded in by the partial throttle).
 */
function initialMessageDeltas(message: AssistantMessage): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  message.content.forEach((block, contentIndex) => {
    if (block.type === 'text' && block.text) {
      out.push({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_delta', contentIndex, delta: block.text, partial: message },
      });
    } else if (block.type === 'thinking' && block.thinking) {
      out.push({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'thinking_delta', contentIndex, delta: block.thinking, partial: message },
      });
    }
  });
  return out;
}
