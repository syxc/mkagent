/**
 * Durable kernel session lifecycle.
 *
 * Owns the `Harness`, the root conversation, and the mapping from durable
 * public observer revisions to the pi-coding-agent 1.1.0 `AgentSessionEvent` shapes
 * the host's `PiEventAdapter` already consumes. Storage lives at
 * `<sessionPath>/durable-store/`; a legacy `<sessionPath>/.pi-sessions/`
 * transcript is converted by `migrate.ts` through an open `Harness`, and
 * `id-map.json` records old → new entry ids for branch anchors.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  CompactionTask,
  DEFAULT_COMPACTION_POLICY,
  GenerationTask,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  ProviderDoc,
  createRegistry,
  defineExtension,
  hook,
  section,
  type InputSubmissionDraft,
  type CompactionResult,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryDraft,
  type EntryRecord,
  type Extension,
  type HarnessSettings,
  type Registry,
  type TaskId,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { watchEvents, type AgentEvent } from './events/watch.ts';
import { openDurableStorage } from './storage/durable-storage.ts';
import { discardInheritedWork } from './storage/branch-storage.ts';
import { migrateLegacyCodingWork } from './storage/coding-migration.ts';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { AssistantMessage, Models, ModelThinkingLevel as ThinkingLevel, ToolCall, UserMessage } from '@earendil-works/pi-ai';
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { AgentSessionEvent } from '@mkagent/shared/agent/pi-events';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { findMostRecentSessionFile, migrateParentStore, migrateLegacySession, readEntryIdMap, readLegacyBranchConversation } from './migrate.ts';
import { compactionReserveFor } from './compaction-reserve.ts';
import { CacheWarmer } from './cache-warmer.ts';
import { copyReferencedSessionFiles, remapSessionFileReferences } from '@mkagent/shared/sessions';
import { rewriteStoredModelHistory } from '@mkagent/shared/sessions/model-history-paths';
import { CodingHost, type KernelCodingOptions } from './coding-host.ts';
import type { ExtensionUIHost } from './extension-ui.ts';

import type { ModelRuntimeCredentials, AgentSessionEvent as NativeAgentSessionEvent } from '@mkagent/pi-durable-coding/native';

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
  modelCredentialsSource?(): ModelRuntimeCredentials;
  hooks: KernelHooks;
  /** Tools extension installed on the registry (wrapped builtin + session + MCP tools). */
  toolsExtension: Extension;
  /** Extra extensions installed beside the tools extension (codemode, tool_search). */
  extensions?: readonly Extension[];
  coding?: KernelCodingOptions;
  codingUI?: ExtensionUIHost;
  /** Apply the same approval and output policy used for the host's own tools. */
  wrapCodingTool?(tool: ToolRegistration): ToolRegistration;
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

type CodingInputOptions = {
  source?: 'interactive' | 'extension' | 'rpc';
  expandPromptTemplates?: boolean;
  nativeInput?: { text: string; hostContextPrefix: string };
};

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
  private registry: Registry<ToolRegistration> | null = null;
  private conversation: Conversation | null = null;
  private readonly manualCompactions = new Set<{ controller: AbortController; done: Promise<void> }>();
  private readonly cacheWarmer = new CacheWarmer(
    () => this.conversation,
    () => this.harness,
    async (taskId, model, options) => {
      if (!this.harness || !this.conversation) return false;
      const conversation = this.conversation;
      const [live, task, agent, provider] = await Promise.all([
        this.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT),
        this.harness.getTask(taskId, BACKGROUND_CONTEXT),
        conversation.agent(BACKGROUND_CONTEXT),
        this.harness.snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT),
      ]);
      if (live?.run?.taskId !== taskId || agent.model?.provider !== model.provider
        || agent.model?.modelId !== model.id || provider?.sessionId !== options.sessionId) return false;
      const checkpoint = task?.state.checkpoint;
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
      const view = await conversation.context(BACKGROUND_CONTEXT);
      if (checkpoint.phase === 'request' && typeof checkpoint.cutoff === 'number') {
        return !view.head || view.head.id <= checkpoint.cutoff;
      }
      if (checkpoint.phase === 'tools' && typeof checkpoint.assistant === 'number') {
        return !view.head || view.head.id <= checkpoint.assistant;
      }
      return false;
    },
  );
  private readonly options: DurableKernelOptions;
  private detachWatch: (() => void) | null = null;
  private readonly retry: RetrySynthState = { pending: false, active: false, attempt: 0, errorMessage: undefined };
  private lastUsage: { totalTokens: number } | undefined;
  /** In-flight assistant partial (message_start → message_end). */
  private partial: AssistantMessage | undefined;
  /** Final assistant message of the most recent turn. */
  private lastAssistant: AssistantMessage | undefined;
  /** Session tool calls (`session__` / `mcp__session__`) awaiting their result. */
  private pendingSessionTools = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  /** Retained output window per running tool call (append/trimStart semantics). */
  private toolOutputBuffers = new Map<string, string>();
  private pendingInputs = new Set<Promise<void>>();
  private inputAdmission: Promise<boolean> = Promise.resolve(true);
  private acceptedInputs = new Set<number>();
  private startedInputs = new Set<number>();
  private coding: CodingHost | undefined;
  private codingReload: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private nativeTools: ToolRegistration[] = [];
  private hostTools: Extension;
  private thinkingLevel: ThinkingLevel = 'off';
  private runController = new AbortController();

  constructor(options: DurableKernelOptions) {
    this.options = options;
    this.hostTools = options.toolsExtension;
  }

  private get storeDir(): string {
    return join(this.options.sessionPath, 'durable-store');
  }

  /**
   * Open (or resume) the durable store. Order matters: the branch copy runs
   * before the store opens, and the legacy migration needs the open Harness.
   */
  async open(config: KernelOpenOptions): Promise<void> {
    const resuming = existsSync(join(this.storeDir, 'session-id.txt'));
    const branchFrom = config.branchFromSessionPath;
    const legacyChild = findMostRecentSessionFile(join(this.options.sessionPath, '.pi-sessions'));
    const pendingBranch = join(this.options.sessionPath, '.durable-branch-pending');
    if (existsSync(pendingBranch)) {
      throw new Error('Pi branch preflight failed: an incomplete branch store requires recovery');
    }
    let copiedParent = false;
    let ownsPendingBranch = false;
    try {
      if (branchFrom && !existsSync(this.storeDir) && !legacyChild) {
        if (!config.branchFromSdkTurnId) {
          throw new Error('Pi branch preflight failed: a branch turn anchor is required');
        }
        // A parent that has never opened under this kernel gets its legacy
        // transcript converted in place first, so the copy carries full context.
        await migrateParentStore(branchFrom, this.options.hooks.debugLog);
        const parentStore = join(branchFrom, 'durable-store');
        if (!existsSync(join(parentStore, 'store.db')) && !existsSync(join(parentStore, 'main.jsonl'))) {
          throw new Error(`Pi branch preflight failed: no parent session transcript found in ${branchFrom}`);
        }
        mkdirSync(this.options.sessionPath, { recursive: true });
        writeFileSync(pendingBranch, 'pending', { flag: 'wx' });
        ownsPendingBranch = true;
        mkdirSync(this.storeDir);
        copiedParent = true;
        const parentDb = join(parentStore, 'store.db');
        const parentMain = join(parentStore, 'main.jsonl');
        // A torn JSONL copy can look recoverable while silently losing newer commits.
        const mainBefore = existsSync(parentMain) ? readFileSync(parentMain) : undefined;
        cpSync(parentStore, this.storeDir, {
          recursive: true,
          filter: source => !['store.db', 'store.db-wal', 'store.db-shm', 'session-id.txt'].includes(source.split(/[\\/]/).at(-1)!),
        });
        if (mainBefore) {
          const mainCopied = readFileSync(join(this.storeDir, 'main.jsonl'));
          const mainAfter = readFileSync(parentMain);
          if ((mainBefore.length > 0 && mainBefore.at(-1) !== 10)
            || !mainBefore.equals(mainCopied) || !mainBefore.equals(mainAfter)) {
            throw new Error('Pi branch preflight failed: parent JSONL store changed during copy');
          }
          for (const name of readdirSync(this.storeDir)) {
            if (!/^(?:doc|task)-\d+\.jsonl$/.test(name)) continue;
            const copied = readFileSync(join(this.storeDir, name));
            if ((copied.length > 0 && copied.at(-1) !== 10) || !copied.equals(readFileSync(join(parentStore, name)))) {
              throw new Error('Pi branch preflight failed: parent JSONL store changed during copy');
            }
          }
        }
        if (existsSync(parentDb)) {
          const database = new Database(parentDb, { readonly: true });
          try {
            database.query('VACUUM INTO ?').run(join(this.storeDir, 'store.db'));
          } finally {
            database.close();
          }
        }
      }

      if (copiedParent) {
        rewriteStoredModelHistory(this.options.sessionPath,
          value => remapSessionFileReferences(value, branchFrom!, this.options.sessionPath));
      }
      await this.openStore(copiedParent);

      // Complete any deferred parent migration in the copy before resolving its branch anchor.
      // Existing root entries remain intact; the transcript also restores model/thinking defaults.
      const legacy = await migrateLegacySession(this.harness!, this.options.sessionPath, this.options.hooks.debugLog,
        copiedParent ? branchFrom : undefined);

      // Branch cutoff: fork the copied conversation at the anchor entry, dropping
      // everything after it. Missing and unresolvable cutoffs must not silently
      // resume the parent's later context.
      if (copiedParent) {
        const anchor = config.branchFromSdkTurnId ? this.resolveBranchAnchor(config.branchFromSdkTurnId) : undefined;
        if (config.branchFromSdkTurnId && anchor === undefined) {
          throw new Error(`Pi branch preflight failed: branch anchor not found: ${config.branchFromSdkTurnId}`);
        }
        if (anchor !== undefined && this.conversation) {
          const branchConversation = config.branchFromSdkTurnId
            ? await readLegacyBranchConversation(this.harness!, config.branchFromSdkTurnId)
            : undefined;
          let source = this.conversation;
          if (branchConversation !== undefined && !existsSync(join(branchFrom!, 'durable-store', 'conversation-id.txt'))) {
            const migrated = await this.harness!.conversation(branchConversation, BACKGROUND_CONTEXT);
            if (!migrated) throw new Error('Pi branch preflight failed: migrated conversation not found');
            source = migrated;
          }
          const forked = await source.fork(anchor, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
          this.conversation = forked;
          writeFileSync(join(this.storeDir, 'conversation-id.txt'), String(forked.id));
          this.detachWatch?.();
          await this.attachWatch(forked.id);
          this.options.hooks.debugLog(`Applied branch cutoff at durable entry ${anchor}`);
        }
      }

      if (copiedParent && this.conversation) {
        const view = await this.conversation.context(BACKGROUND_CONTEXT);
        const sourceReferences = remapSessionFileReferences(view.contributions.flat(), this.options.sessionPath, branchFrom!);
        copyReferencedSessionFiles(sourceReferences, branchFrom!, this.options.sessionPath);
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
      this.thinkingLevel = (await this.conversation!.agent(BACKGROUND_CONTEXT)).thinkingLevel as ThinkingLevel;
      await this.openCoding(copiedParent ? 'fork' : legacyChild || resuming ? 'resume' : 'startup');
      this.harness!.resume();
      if (copiedParent) {
        unlinkSync(pendingBranch);
      }
    } catch (error) {
      if (ownsPendingBranch) {
        try {
          if (copiedParent) {
            await this.close();
            rmSync(this.storeDir, { recursive: true });
          }
          unlinkSync(pendingBranch);
        } catch (cleanupError) {
          this.options.hooks.debugLog(`Failed to clean incomplete branch store: ${String(cleanupError)}`);
        }
      }
      throw error;
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
    if (this.options.coding) return;
    const stream = await watchEvents(this.harness!, conversationId, BACKGROUND_CONTEXT);
    const pendingCompactions = new Map<number, { reason: 'manual' | 'threshold' | 'overflow'; tokensBefore: number }>();
    let delivery = Promise.resolve();
    let watching = true;
    let frame = 0;
    let latestRunStart = 0;
    const deliver = async (events: readonly AgentEvent[], frame: number): Promise<void> => {
      if (!watching) return;
      // Durable publishes retry and the failed entry in one commit, with retry first.
      const retryIndex = events.findIndex(event => event.type === 'auto_retry_start');
      const failureIndex = retryIndex < 0 ? -1 : events.findIndex((event, index) => {
        const message = event.type === 'message_end' ? event.entry.model?.[0] : undefined;
        return index > retryIndex && message?.role === 'assistant' && message.stopReason === 'error';
      });
      const ordered = failureIndex < 0 ? events : [
        ...events.slice(0, retryIndex), ...events.slice(retryIndex + 1, failureIndex + 1),
        events[retryIndex]!, ...events.slice(failureIndex + 1),
      ];
      // A durable frame can replace a completed run with queued input atomically.
      const successor = events.some(event => event.type === 'run_start');
      for (const event of ordered) {
        if (!watching) return;
        if (event.type === 'run_end' && successor) continue;
        const retrying = this.retry.pending || this.retry.active;
        let synthesizedEvents = event.type === 'run_end' ? [] : this.synthesizeEvent(event);
        let settledCompaction = false;
        if (event.type === 'submission' && event.record.status !== 'queued') {
          const pending = pendingCompactions.get(event.record.id);
          if (pending) {
            pendingCompactions.delete(event.record.id);
            settledCompaction = true;
            synthesizedEvents = event.record.status === 'done'
              ? [{ type: 'compaction_end', reason: pending.reason, result: { summary: '', firstKeptEntryId: '', tokensBefore: pending.tokensBefore }, aborted: false, willRetry: false }]
              : [{ type: 'compaction_end', reason: pending.reason, result: undefined, aborted: false, willRetry: false, errorMessage: `Compaction summary was not placed: ${event.record.reason}` }];
          }
        }
        if (event.type === 'compaction_end' && !event.error && this.harness) {
          try {
            const task = await this.harness.waitForTask(event.taskId as TaskId<CompactionResult>, BACKGROUND_CONTEXT);
            const outcome = task.state.outcome;
            if (outcome.status !== 'completed') {
              synthesizedEvents = [{ type: 'compaction_end', reason: event.reason, result: undefined, aborted: outcome.status === 'aborted', willRetry: false, errorMessage: outcome.error?.message ?? outcome.reason ?? `Compaction ${outcome.status}` }];
            } else if (outcome.result.submissionId !== undefined) {
              const submission = await this.harness.submission(outcome.result.submissionId, BACKGROUND_CONTEXT);
              if (!submission) throw new Error('Compaction summary submission not found');
              const record = await submission.status(BACKGROUND_CONTEXT);
              if (record.status === 'queued') {
                pendingCompactions.set(record.id, { reason: event.reason, tokensBefore: this.lastUsage?.totalTokens ?? 0 });
                synthesizedEvents = [];
              } else if (record.status !== 'done') {
                synthesizedEvents = [{ type: 'compaction_end', reason: event.reason, result: undefined, aborted: false, willRetry: false, errorMessage: `Compaction summary was not placed: ${record.reason}` }];
              }
            } else if (outcome.result.entryId === undefined) {
              synthesizedEvents = [{ type: 'compaction_end', reason: event.reason, result: undefined, aborted: false, willRetry: false, errorMessage: 'Nothing to compact (session too small)' }];
            }
          } catch (error) {
            synthesizedEvents = [{ type: 'compaction_end', reason: event.reason, result: undefined, aborted: false, willRetry: false, errorMessage: error instanceof Error ? error.message : String(error) }];
          }
        }
        if (event.type === 'entry_appended' && event.entry.kind === 'pi.compaction') this.cacheWarmer.stop();
        if (event.type === 'run_end' && this.harness) {
          try {
            const live = await this.harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
            if (!live?.run) this.cacheWarmer.stop();
          } catch (error) {
            this.options.hooks.debugLog(`Could not reconcile cache warming: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (event.type === 'run_end' && this.autoCompactionEnabled && !retrying) {
          try {
            await this.scheduleThresholdCompaction();
          } catch (error) {
            this.options.hooks.debugLog(`Could not schedule automatic compaction: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const needsContext = event.type === 'message_end' || event.type === 'turn_end'
          || event.type === 'run_end' || event.type === 'compaction_start' || event.type === 'compaction_end' || settledCompaction;
        let usage: Awaited<ReturnType<DurableKernel['contextUsagePayload']>> | undefined;
        if (needsContext) {
          try {
            usage = await this.contextUsagePayload();
          } catch (error) {
            this.options.hooks.debugLog(`Could not read context usage: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!watching) return;
        if (event.type === 'run_end') {
          // Input committed while host reconciliation awaited belongs to this interaction.
          while (this.pendingInputs.size) await Promise.allSettled([...this.pendingInputs]);
          if (!watching) return;
          if (latestRunStart > frame || this.acceptedInputs.size) continue;
          synthesizedEvents = this.synthesizeEvent(event);
        }
        for (const synthesized of synthesizedEvents) {
          this.options.hooks.emitEvent(usage ? { ...synthesized, ...usage } : synthesized);
        }
      }
    };
    stream.start(async events => {
      // Drain the SDK watch immediately so it retains exact frames while host-side work awaits.
      const currentFrame = ++frame;
      for (const event of events) {
        if (event.type === 'submission' && event.record.status !== 'queued') {
          if (!this.acceptedInputs.delete(event.record.id) && this.pendingInputs.size) this.startedInputs.add(event.record.id);
        }
        if (event.type !== 'run_start') continue;
        latestRunStart = currentFrame;
        for (const id of event.inputs) {
          if (!this.acceptedInputs.delete(id) && this.pendingInputs.size) this.startedInputs.add(id);
        }
      }
      delivery = delivery.then(() => deliver(events, currentFrame)).catch(error => {
        this.options.hooks.debugLog(`Could not deliver durable events: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.detachWatch = () => {
      watching = false;
      void stream.stop();
    };
  }

  private async scheduleThresholdCompaction(): Promise<void> {
    if (!this.lastAssistant || this.lastAssistant.stopReason === 'aborted') return;
    const conversation = this.conversation;
    const contextWindow = this.currentModel?.contextWindow;
    if (!conversation || !contextWindow) return;
    const { contextUsage, compactionSettings } = await this.contextUsagePayload();
    if (contextUsage?.tokens == null || contextUsage.tokens <= contextWindow - compactionSettings.reserveTokens) return;
    const view = await conversation.context(BACKGROUND_CONTEXT);
    // Upstream retains conversation messages, not system prompt and tool definitions.
    const retainedTokens = view.contributions
      .slice(view.head ? 1 : 0)
      .flat()
      .reduce((total, message) => total + (message.role === 'system' ? 0 : estimateMessageTokens(message)), 0);
    if (retainedTokens < DEFAULT_COMPACTION_POLICY.keepRecentTokens) return;

    await conversation.commit(async tx => {
      const live = await tx.doc(LiveDoc, conversation.id);
      if (live.run || live.compactions?.length) return;
      const taskId = await tx.createTask(CompactionTask, { reason: 'threshold' }, {
        ownership: { kind: 'conversation' }, background: true,
      });
      live.compactions = [{ taskId, trigger: 'threshold', blocking: false, attempt: 1 }];
    }, BACKGROUND_CONTEXT);
  }

  private async openStore(copiedParent: boolean): Promise<void> {
    const storage = await openDurableStorage(this.storeDir, BACKGROUND_CONTEXT);
    const marker = join(this.storeDir, 'conversation-id.txt');
    let selected: ConversationId | undefined;
    if (existsSync(marker)) {
      const rawId = readFileSync(marker, 'utf-8').trim();
      const parsedId = Number(rawId);
      if (!Number.isSafeInteger(parsedId) || String(parsedId) !== rawId) {
        await storage.close(BACKGROUND_CONTEXT);
        throw new Error('Invalid durable branch conversation id');
      }
      selected = parsedId as ConversationId;
    }
    if (copiedParent) {
      try {
        // Clear inherited work before Harness.open can reconcile it; abort/wait APIs can schedule it.
        await discardInheritedWork(storage);
      } catch (error) {
        await storage.close(BACKGROUND_CONTEXT).catch(() => {});
        throw error;
      }
    }
    if (!copiedParent && this.options.coding) {
      try { await migrateLegacyCodingWork(storage, selected ?? ROOT_CONVERSATION_ID); }
      catch (error) {
        await storage.close(BACKGROUND_CONTEXT).catch(() => {});
        throw error;
      }
    }

    const registry = createRegistry<ToolRegistration>();
    this.registry = registry;

    // Craft replaces the entire system prompt: tag:false keeps the text
    // verbatim, and no other extension contributes sections.
    registry.install(defineExtension({
      name: 'mkagent-system-prompt',
      sections: [section('mkagent-system-prompt', () => this.coding?.systemPrompt ?? this.systemPrompt, { tag: false })],
      hooks: [hook(GenerationTask, {
        beforeRequest: request => {
          const systemPrompt = this.coding?.systemPrompt ?? this.systemPrompt;
          return systemPrompt === undefined ? undefined : {
            messages: [
              { role: 'system' as const, content: systemPrompt, toolsAdded: getCurrentTools(request.messages), timestamp: Date.now() },
              ...request.messages.filter(message => message.role !== 'system'),
            ],
          };
        },
      })],
    }));
    registry.install(this.options.toolsExtension);
    for (const extension of this.options.extensions ?? []) registry.install(extension);
    registry.install(defineExtension({
      name: 'mkagent-cache-warmer',
      hooks: [hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          try {
            await this.cacheWarmer.capture(request, api, context);
          } catch (error) {
            this.options.hooks.debugLog(`Could not schedule cache warming: ${error instanceof Error ? error.message : String(error)}`);
          }
          return undefined;
        },
        afterResponse: message => this.cacheWarmer.observe(message.usage),
      })],
    }));

    this.harness = await Harness.open(storage, {
      models: () => this.currentModels(),
      registry,
      settings: () => this.buildSettings(),
      env: target => new NodeExecutionEnv({
        cwd: target.cwd ?? this.options.cwd,
        ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
      }),
      onReport: ({ kind, error }) => {
        this.options.hooks.debugLog(`[kernel] ${kind}: ${error instanceof Error ? error.message : String(error)}`);
      },
    }, BACKGROUND_CONTEXT);

    if (selected !== undefined) {
      const existing = await this.harness.conversation(selected, BACKGROUND_CONTEXT);
      if (!existing) throw new Error(`Durable branch conversation not found: ${selected}`);
      this.conversation = existing;
    } else {
      this.conversation = await this.harness.root(BACKGROUND_CONTEXT, {
        agent: this.currentModel
          ? { model: { provider: this.currentModel.provider, modelId: this.currentModel.modelId } }
          : undefined,
      });
    }
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
        backgroundTokens: 0,
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

  private async openCoding(reason: 'startup' | 'resume' | 'fork' | 'new' | 'reload'): Promise<void> {
    const profile = this.options.coding;
    if (!profile) return;
    if (!this.options.wrapCodingTool) throw new Error('Coding extensions require the host tool approval wrapper');
    this.nativeTools = [];
    this.installTools();
    this.coding = await CodingHost.load({
      harness: this.harness!, conversation: this.conversation!, registry: this.registry!,
      cwd: this.options.cwd, sessionPath: this.options.sessionPath, id: this.sessionId, profile,
      models: this.options.modelsSource, credentials: this.options.modelCredentialsSource?.(),
      autoCompactWindow: this.options.autoCompactWindow, ui: this.options.codingUI,
      model: async models => {
        const selected = this.currentModel ?? (await this.conversation!.agent(BACKGROUND_CONTEXT)).model;
        return selected && models.getModel(selected.provider, selected.modelId);
      },
      thinkingLevel: () => this.thinkingLevel,
      selection: (model, thinkingLevel) => {
        if (model) this.currentModel = { provider: model.provider, modelId: model.id, contextWindow: model.contextWindow };
        this.thinkingLevel = thinkingLevel;
      },
      shutdown: () => { void this.abort().then(() => this.close()); },
      getSystemPrompt: () => this.systemPrompt,
      wrapTool: this.options.wrapCodingTool,
      publishTools: tools => {
        this.nativeTools = tools;
        this.installTools();
      },
      event: event => this.nativeEvent(event),
      error: error => this.options.hooks.debugLog(`[coding:${error.event}] ${error.extensionPath}: ${error.error}`),
      commands: {
        waitForIdle: () => this.waitForIdle(),
        newSession: async options => {
          if (options?.parentSession !== undefined || options?.setup !== undefined || options?.withSession !== undefined) {
            throw new Error('newSession parentSession, setup and withSession require the MkAgent session owner');
          }
          return this.changeCodingSession();
        },
        fork: async (id, options) => {
          if (options?.withSession !== undefined) throw new Error('fork withSession requires the MkAgent session owner');
          return this.changeCodingSession(id, options?.position ?? 'before');
        },
        navigateTree: async () => { throw new Error('Native tree navigation requires the MkAgent session owner'); },
        switchSession: async () => { throw new Error('Session switching requires the MkAgent session owner'); },
        reload: () => this.reloadCodingSession(),
      },
    }, reason);
    await this.coding.start(reason);
  }

  private reloadCodingSession(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Cannot reload a coding session while closing'));
    if (this.codingReload) return this.codingReload;
    // Register before starting, including the interval without an active coding host.
    const operation = Promise.resolve().then(async () => {
      const resumeUI = this.options.codingUI?.suspend();
      try {
        await this.waitForIdle();
        await this.coding?.close();
        this.coding = undefined;
      } finally {
        resumeUI?.();
      }
      await this.openCoding('reload');
    });
    this.codingReload = operation;
    return operation.finally(() => {
      if (this.codingReload === operation) this.codingReload = undefined;
    });
  }

  /** Native AgentSession supplies its own events; only add host metadata and accounting. */
  private nativeEvent(event: NativeAgentSessionEvent | Record<string, unknown>): void {
    const selected = this.coding?.session.model;
    if (selected) this.currentModel = { provider: selected.provider, modelId: selected.id, contextWindow: selected.contextWindow };
    if (event.type === 'agent_start') this.busy = true;
    if (event.type === 'agent_settled') this.busy = false;
    if (event.type === 'thinking_level_changed') this.thinkingLevel = event.level as ThinkingLevel;
    if (event.type === 'message_end' && 'message' in event) {
      const message = event.message as AssistantMessage;
      if (message.role === 'assistant') {
        this.lastAssistant = message;
        this.lastUsage = message.usage;
        const calls = message.content.filter((part): part is ToolCall => part.type === 'toolCall')
          .filter(call => this.options.hooks.isPrefetchableTool(call.name));
        if (calls.length >= 2) for (const call of calls) {
          this.options.hooks.prefetchToolCall(call.id, call.name, call.arguments);
        }
      }
    }
    if (event.type === 'tool_execution_start') {
      const name = String(event.toolName);
      const sessionName = name.replace(/^(mcp__session__|session__)/, '');
      if (name !== sessionName) this.pendingSessionTools.set(String(event.toolCallId), {
        toolName: sessionName, args: event.args as Record<string, unknown>,
      });
    } else if (event.type === 'tool_execution_end') {
      const call = this.pendingSessionTools.get(String(event.toolCallId));
      if (call) {
        this.pendingSessionTools.delete(String(event.toolCallId));
        this.options.hooks.sessionToolCompleted(call.toolName, call.args, event.isError === true);
      }
    }
    // Native custom messages and new lifecycle events extend the legacy wire union.
    this.options.hooks.emitEvent(event as unknown as Record<string, unknown>);
  }

  private async changeCodingSession(nativeId?: string, position: 'at' | 'before' = 'at') {
    if (this.closing) throw new Error('Cannot change a coding session while closing');
    await this.abort();
    const previous = this.conversation!;
    const agent = await previous.agent(BACKGROUND_CONTEXT);
    let target: EntryId | undefined;
    if (nativeId) {
      const entries = this.coding!.journal.manager.getEntries();
      const selected = entries.find(entry => entry.id === nativeId);
      if (!selected) throw new Error(`Native branch entry not found: ${nativeId}`);
      const id = position === 'before' ? selected.parentId : selected.id;
      target = id ? this.coding!.journal.durableId(id) : undefined;
      if (id && target === undefined) throw new Error(`Native branch anchor not persisted: ${id}`);
    }
    let next: Conversation;
    if (target !== undefined) next = await previous.fork(target, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    else {
      const record = await this.harness!.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
      next = (await this.harness!.conversation(record.id, BACKGROUND_CONTEXT))!;
      await next.configure(agent, BACKGROUND_CONTEXT);
    }
    await this.coding!.close();
    this.coding = undefined;
    this.conversation = next;
    this.sessionId = randomUUID();
    writeFileSync(join(this.storeDir, 'session-id.txt'), this.sessionId);
    writeFileSync(join(this.storeDir, 'conversation-id.txt'), String(next.id));
    this.detachWatch?.();
    await this.attachWatch(next.id);
    await this.openCoding(nativeId ? 'fork' : 'new');
    return { cancelled: false };
  }

  async submitPrompt(message: string, images?: Array<{ data: string; mimeType: string }>,
    nativeInput?: CodingInputOptions['nativeInput']): Promise<{ handled: boolean; completed: boolean }> {
    const content = images?.length ? [{ type: 'text' as const, text: message },
      ...images.map(image => ({ ...image, type: 'image' as const }))] : message;
    const operation = this.enqueueCodingInput(content, 'followUp', { nativeInput, source: nativeInput ? 'rpc' : undefined });
    let tail = this.inputAdmission;
    const handled = await operation;
    let completed = handled;
    // Commands may enqueue native prompts before their own admission finishes.
    while (completed && tail !== this.inputAdmission) {
      tail = this.inputAdmission;
      completed = await tail;
    }
    if (!this.closing) await this.coding?.flush();
    return { handled, completed: completed && !this.coding?.isStreaming };
  }

  async steer(message: string): Promise<void> {
    await this.enqueueCodingInput(message, 'steer');
    if (!this.closing) await this.coding?.flush();
  }

  private enqueueCodingInput(content: UserMessage['content'], mode: 'steer' | 'followUp',
    options: CodingInputOptions = {}): Promise<boolean> {
    const operation = this.inputAdmission.then(() => this.processCodingInput(content, mode, options));
    this.inputAdmission = operation.catch(() => true);
    return operation;
  }

  private async processCodingInput(raw: UserMessage['content'], mode: 'steer' | 'followUp',
    options: CodingInputOptions): Promise<boolean> {
    if (!this.conversation) throw new Error('Kernel not open');
    if (this.coding) {
      const text = typeof raw === 'string' ? raw : raw.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const images = typeof raw === 'string' ? undefined : raw.filter(part => part.type === 'image');
      return this.coding.submit(options.nativeInput?.text ?? text, {
        images, source: options.source,
        hostContextPrefix: options.nativeInput?.hostContextPrefix,
        expandPromptTemplates: options.expandPromptTemplates ?? true,
        streamingBehavior: mode,
      });
    }
    this.requireModel(this.currentModel);
    await this.submitInput({ type: 'input', content: raw, whenBusy: mode });
    return false;
  }

  private async submitInput(request: InputSubmissionDraft): Promise<void> {
    const admitted = this.conversation!.submit(request, BACKGROUND_CONTEXT);
    const pending = admitted.then(submission => {
      if (!this.startedInputs.delete(submission.id)) this.acceptedInputs.add(submission.id);
    });
    this.pendingInputs.add(pending);
    try { await pending; }
    finally {
      this.pendingInputs.delete(pending);
      if (!this.pendingInputs.size) this.startedInputs.clear();
    }
  }

  async abort(): Promise<void> {
    const resumeUI = this.options.codingUI?.suspend();
    try {
      this.runController.abort();
      this.cacheWarmer.stop();
      const conversation = this.conversation;
      if (!conversation || !this.harness) return;

      const compactions = [...this.manualCompactions];
      for (const compaction of compactions) compaction.controller.abort();
      for (;;) {
        const active = this.coding;
        const reloading = this.codingReload;
        if (active) await active.abort();
        else await conversation.abort(BACKGROUND_CONTEXT);
        if (reloading) {
          await reloading;
          // Startup can launch native work after the first abort.
          continue;
        }
        if (active === this.coding) break;
      }
      await Promise.all(compactions.map(compaction => compaction.done));
    } finally {
      resumeUI?.();
    }
  }

  private currentModels(): Models {
    return this.coding?.models ?? this.options.modelsSource();
  }

  private requireModel(model: KernelModelRef | undefined): void {
    if (!model || !this.currentModels().getModel(model.provider, model.modelId)) {
      throw new Error(`Could not resolve model: ${model ? `${model.provider}/${model.modelId}` : '(unset)'}`);
    }
  }

  async waitForIdle(context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.coding) await this.coding.waitForIdle();
    else await this.conversation?.waitForIdle(context);
  }

  async setModel(model: KernelModelRef, models: Models = this.currentModels(), context = BACKGROUND_CONTEXT): Promise<void> {
    if (!models.getModel(model.provider, model.modelId)) {
      throw new Error(`Could not resolve model: ${model.provider}/${model.modelId}`);
    }
    this.cacheWarmer.stop();
    await this.conversation?.configure({ model: { provider: model.provider, modelId: model.modelId } }, context);
    this.currentModel = model;
    if (this.coding) {
      await this.coding.session.setModel(models.getModel(model.provider, model.modelId)!);
      await this.coding.flush();
    }
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.cacheWarmer.stop();
    await this.conversation?.configure({ thinkingLevel: level as never }, BACKGROUND_CONTEXT);
    this.thinkingLevel = level as ThinkingLevel;
    if (this.coding) {
      this.coding.session.setThinkingLevel(level as ThinkingLevel);
      await this.coding.flush();
    }
  }

  setAutoCompaction(enabled: boolean): void {
    this.autoCompactionEnabled = enabled;
    this.coding?.session.setAutoCompactionEnabled(enabled);
  }

  getAutoCompactionEnabled(): boolean {
    return this.coding?.session.autoCompactionEnabled ?? this.autoCompactionEnabled;
  }

  /** Manual compaction in the host's PiCompactResult shape. */
  async compact(customInstructions?: string, signal?: AbortSignal): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
  }> {
    if (this.coding) {
      const abort = () => this.coding?.session.abortCompaction();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const result = await this.coding.session.compact(customInstructions);
        await this.coding.flush();
        return result;
      } finally { signal?.removeEventListener('abort', abort); }
    }
    const conversation = this.conversation;
    const harness = this.harness;
    if (!conversation || !harness) throw new Error('Kernel not open');
    const finished = Promise.withResolvers<void>();
    const controller = new AbortController();
    const compaction = { controller, done: finished.promise };
    let taskId: TaskId<CompactionResult> | undefined;
    let submissionId: CompactionResult['submissionId'];
    let cancellation: Promise<unknown> = Promise.resolve();
    const cancel = (): void => {
      // Queue cancellation on the SDK's session line; repeat after admission or receipt if needed.
      if (submissionId !== undefined) cancellation = harness.abortSubmission(submissionId, BACKGROUND_CONTEXT, conversation.id);
      else if (taskId !== undefined) cancellation = harness.abortTask(taskId, BACKGROUND_CONTEXT);
      void cancellation.catch(() => {});
    };
    controller.signal.addEventListener('abort', cancel);
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort);
    if (signal?.aborted) controller.abort();
    this.manualCompactions.add(compaction);
    try {
      const tokensBefore = (await this.contextUsagePayload()).contextUsage?.tokens ?? 0;
      if (controller.signal.aborted) throw new Error('Compaction aborted');
      taskId = await conversation.compact(customInstructions, BACKGROUND_CONTEXT);
      if (controller.signal.aborted) cancel();
      const task = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
      const outcome = task.state.outcome;
      if (outcome.status !== 'completed') {
        throw new Error(outcome.error?.message ?? outcome.reason ?? `Compaction ${outcome.status}`);
      }
      let entryId = outcome.result.entryId;
      if (outcome.result.submissionId !== undefined) {
        submissionId = outcome.result.submissionId;
        if (controller.signal.aborted) cancel();
        const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
        if (!submission) throw new Error('Compaction summary submission not found');
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.status !== 'done') throw new Error(`Compaction summary was not placed: ${settled.reason}`);
        entryId = settled.entry;
      }
      if (controller.signal.aborted) throw new Error('Compaction aborted');
      if (entryId === undefined) throw new Error('Nothing to compact (session too small)');
      const entry = await this.getEntry(entryId);
      // The compaction entry holds the wrapped summary as a user message; its
      // head is the first entry kept in the new context.
      const message = entry?.kind === 'pi.compaction' ? entry.model?.[0] : undefined;
      const summary = message?.role === 'user'
        ? (typeof message.content === 'string'
          ? message.content
          : message.content.filter(c => c.type === 'text').map(c => c.text).join(''))
        : '';
      const view = await conversation.context(BACKGROUND_CONTEXT);
      const estimatedTokensAfter = entry?.kind === 'pi.compaction'
        ? view.messages.reduce((total, item) => total + estimateMessageTokens(item), 0)
        : undefined;
      return {
        summary,
        firstKeptEntryId: entry?.head !== undefined ? String(entry.head) : '',
        tokensBefore,
        estimatedTokensAfter,
      };
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      controller.signal.removeEventListener('abort', cancel);
      try {
        await cancellation;
      } finally {
        this.manualCompactions.delete(compaction);
        finished.resolve();
      }
    }
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

  /** Publish a new host catalog and rebuild the native declarations without reloading extensions. */
  updateTools(extension: Extension): void {
    this.hostTools = extension;
    this.installTools();
    const nativeNames = new Set(this.nativeTools.map(tool => tool.name));
    this.coding?.updateTools(this.registry!.snapshot().tools()
      .flatMap(({ tool }) => nativeNames.has(tool.name) ? [] : [tool]));
  }

  private installTools(): void {
    const extension = this.hostTools;
    const names = new Set(this.nativeTools.map(tool => tool.name));
    this.registry?.install(defineExtension({
      ...extension, tools: [...(extension.tools ?? []).filter(tool => !names.has(tool.name)), ...this.nativeTools],
    }));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    const resumeUI = this.options.codingUI?.suspend();
    // Cancellation is synchronous; draining returned usage can outlive this call.
    const warming = this.cacheWarmer.close();
    const compactions = [...this.manualCompactions];
    for (const compaction of compactions) compaction.controller.abort();
    void (async () => {
      try {
        // The command reports reload errors; teardown must still release its kernel.
        await this.codingReload?.catch(() => undefined);
        await Promise.all([warming, ...compactions.map(compaction => compaction.done)]);
        await this.coding?.close();
        this.coding = undefined;
        this.registry = null;
        this.detachWatch?.();
        this.detachWatch = null;
        if (this.harness) {
          await this.harness.close(BACKGROUND_CONTEXT);
          this.harness = null;
        }
        this.conversation = null;
      } finally {
        resumeUI?.();
        this.closing = undefined;
      }
    })().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  // ============================================================
  // Context usage payload (PiContextUsagePayload contract)
  // ============================================================

  /** Attached to outbound events; derive occupancy from the active conversation. */
  async contextUsagePayload(): Promise<{
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
    compactionSettings: { enabled: boolean; reserveTokens: number };
  }> {
    if (this.coding) return this.coding.contextUsagePayload();
    const compactionSettings = {
      enabled: this.autoCompactionEnabled,
      reserveTokens: compactionReserveFor(
        this.currentModel?.contextWindow,
        DEFAULT_COMPACTION_POLICY.reserveTokens,
        this.options.autoCompactWindow,
      ),
    };
    const contextWindow = this.currentModel?.contextWindow;
    if (!contextWindow || !this.conversation) return { compactionSettings };

    let view: Awaited<ReturnType<Conversation['context']>>;
    try {
      view = await this.conversation.context(BACKGROUND_CONTEXT);
    } catch (error) {
      this.options.hooks.debugLog(`Could not read context usage: ${error instanceof Error ? error.message : String(error)}`);
      return { compactionSettings };
    }
    const messages = view.messages;
    const head = view.head;
    let usageMessage: AssistantMessage | undefined;
    for (let index = view.entries.length - 1; index >= 0 && !usageMessage; index--) {
      const entry = view.entries[index]!;
      if (head?.kind === 'pi.compaction' && entry.id <= head.id) continue;
      const messagesInEntry = view.contributions[index] ?? [];
      for (let offset = messagesInEntry.length - 1; offset >= 0; offset--) {
        const message = messagesInEntry[offset]!;
        if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted'
          && calculateContextTokens(message.usage) > 0) {
          usageMessage = message;
          break;
        }
      }
    }
    const tokens = !usageMessage && head?.kind === 'pi.compaction'
      ? null
      : (usageMessage ? calculateContextTokens(usageMessage.usage) : 0)
        + messages.slice(usageMessage ? messages.indexOf(usageMessage) + 1 : 0)
          .reduce((total, message) => total + estimateMessageTokens(message), 0);
    return {
      contextUsage: { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 },
      compactionSettings,
    };
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

      case 'run_start': {
        const wasBusy = this.busy;
        this.busy = true;
        this.lastAssistant = undefined;
        return wasBusy ? [] : [{ type: 'agent_start' }];
      }

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
        this.partial = event.message;
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

        const sdkMessageId = (message as { id?: string }).id ?? randomUUID();
        const messageEnd: Record<string, unknown> = { type: 'message_end', message, sdkMessageId };
        const out: (AgentSessionEvent | Record<string, unknown>)[] = [messageEnd];

        // Use the same message id for the host's stored message and its durable anchor.
        out.push({ type: 'pi_turn_anchor', sdkMessageId, sdkTurnAnchor: String(event.entry.id) });

        // Speculative prefetch: 2+ prefetchable tool calls in one message fire
        // in parallel before the (possibly sequential) tool round starts.
        try {
          const toolCalls = message.content.filter(c => c.type === 'toolCall') as ToolCall[];
          const prefetchable = toolCalls.filter(tc => this.options.hooks.isPrefetchableTool(tc.name));
          if (prefetchable.length >= 2) {
            for (const tc of prefetchable) {
              this.options.hooks.prefetchToolCall(tc.id, tc.name, (tc.arguments ?? {}) as Record<string, unknown>);
            }
          }
        } catch (error) {
          this.options.hooks.debugLog(`Could not prefetch tool calls: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Retry recovered: announce success before the run's agent_end.
        if (this.retry.active && message.stopReason !== 'error') {
          this.retry.active = false;
          out.push({ type: 'auto_retry_end', success: true, attempt: this.retry.attempt });
        }

        out.push({ type: 'context_usage' });
        return out;
      }

      case 'turn_end':
        return [{
          type: 'turn_end',
          // A turn_end follows this run's assistant message_end.
          message: this.lastAssistant!,
          toolResults: [],
        }];

      case 'tool_execution_start': {
        const args = (event.args ?? {}) as Record<string, unknown>;
        // The host registers session tools as mcp__session__<name>; older paths use session__<name>.
        const sessionToolName = event.toolName.replace(/^(mcp__session__|session__)/, '');
        if (sessionToolName !== event.toolName) {
          this.pendingSessionTools.set(event.toolCallId, {
            toolName: sessionToolName,
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
        }];

      case 'compaction_end': {
        // No post-compaction estimate is present in the durable event.
        const tokens = this.lastUsage?.totalTokens ?? 0;
        const result = event.error
          ? undefined
          : { summary: '', firstKeptEntryId: '', tokensBefore: tokens };
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
