import { buildPrWatchToolCallbacks } from '../pr-watch/tool-callbacks'
import { prEntryId } from '@mkagent/shared/pr-watch'
import { getPrAutoFixMonitor, getPrWatchRegistry } from '../handlers/rpc/pr-watch'
import type { BoundPr, PrMonitorState } from '@mkagent/shared/protocol'
import { addTurnUsage } from './turn-usage'
import { SessionExtensionUI } from './extension-ui'
import { InputOrigins } from './input-origins'
import { NativeSessionOwner } from './native-session-owner'
import { closeNativeForkProof, prepareNativeForkProof, verifyNativeForkTarget, type NativeForkProof } from './native-session-fork'
import { closeNativeSwitchProof, prepareNativeSwitchProof, verifyNativeSwitchTarget, type NativeSwitchProof } from './native-session-switch'
import { readTrustedNativeSession } from './native-session-source'
import { materializeNativeUserHistory } from './native-user-history'
import { partitionNativeProductHistory } from '../../../shared/src/sessions/native-product-history'
import type { PiNativeOwnerBackend, PiNativeOwnerRequest } from '../../../shared/src/agent/backend/pi/native-owner-protocol'
import type { BackgroundTaskOutput, StopBackgroundTaskResult } from '@mkagent/shared/protocol'
import { launchOutputFile, readBackgroundTaskOutput } from './background-task-output'
import type { EventSink, RpcServer } from '@mkagent/server-core/transport'
import { RPC_CHANNELS, generateMessageId } from '@mkagent/shared/protocol'
import type {
  CreateSessionOptions,
  FileAttachment,
  PermissionModeState,
  PermissionResponseOptions,
  SendMessageOptions,
  Session,
  SessionEvent,
  ExtensionUISnapshot,
  UnreadSummary,
} from '@mkagent/shared/protocol'
import type { ISessionManager, IBrowserPaneManager } from '@mkagent/server-core/handlers'
import {
  CONSOLE_LOGGER,
  createScopedLogger,
  type Logger,
  type PlatformServices,
} from '@mkagent/server-core/runtime'
import type {
  ActiveSessionInfo,
  AgentEvent,
  AnnotationV1,
  Message,
  StoredAttachment,
  Workspace,
  WorkspaceInfo,
} from '@mkagent/core/types'
import { messageToStored, storedToMessage } from '@mkagent/core/types'
import {
  AbortReason,
  createBackendFromResolvedContext,
  resolveBackendContext,
  type AgentBackend,
} from '@mkagent/shared/agent/backend'
import {
  mergeSessionScopedToolCallbacks,
  redactBrowserPasswordFills,
  unregisterSessionScopedToolCallbacks,
  type BrowserPaneFns,
} from '@mkagent/shared/agent'
import {
  ConfigWatcher,
  getMiniModel,
  getAutoCompactWindow,
  getWorkspaces,
  resolveTitleLanguageName,
  type ConfigWatcherCallbacks,
} from '@mkagent/shared/config'
import type { LoadedSkill } from '@mkagent/shared/skills'
import { loadWorkspaceConfig } from '@mkagent/shared/workspaces'
import {
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  createSession as createStoredSession,
  createSessionHeader,
  deleteSession as deleteStoredSession,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionPath as getSessionStoragePath,
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  markCompactionComplete as markStoredCompactionComplete,
  saveSession as saveStoredSession,
  sessionPersistenceQueue,
  serializeSession,
  copyReferencedSessionFiles,
  importSessionMessages,
  importNativeArchivedMessages,
  restoreSessionBundleFiles,
  remapSessionFileReferences,
  setPendingPlanExecution as setStoredPendingPlanExecution,
  validateBundle,
  type DispatchMode,
  type SessionBundle,
  type SessionConfig,
  type SessionHeader,
  type SessionMetadata,
  type SessionTokenUsage,
  type StoredSession,
  type NativeSessionOwnerRecord,
  type NativeSessionReference,
  parseNativeSessionReference,
} from '@mkagent/shared/sessions'
import { readFileAttachment } from '@mkagent/shared/utils'
import { getWorkspaceAllowedDirs, validateFilePath } from '@mkagent/server-core/handlers'
import { normalizeThinkingLevel, type ThinkingLevel } from '@mkagent/shared/agent/thinking-levels'
import type { PermissionMode } from '@mkagent/shared/agent/mode-types'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature } from './runtime-config'
import { rollbackFailedBranchCreation, sanitizeForTitle } from '@mkagent/server-core/domain'
import { validateArchiveTarget } from './archive-guards'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { generateConversationSummary } from '@mkagent/shared/agent/conversation-summary'

let platform: PlatformServices | null = null
let log: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

export function setSessionPlatform(nextPlatform: PlatformServices): void {
  platform = nextPlatform
  log = createScopedLogger(nextPlatform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (error: unknown, context?: { errorSource?: string; sessionId?: string }) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

let runtimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  captureException: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
}

function createFallbackTitle(content: string): string | undefined {
  const sanitized = sanitizeForTitle(content)
  return sanitized ? sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '') : undefined
}

export function setSessionRuntimeHooks(hooks: Partial<SessionRuntimeHooks>): void {
  runtimeHooks = { ...runtimeHooks, ...hooks }
}

export const AGENT_FLAGS = {
  isHeadless: false,
  skipConfigWatcher: true,
} as const

interface PiTurnAnchorsIndex {
  version: 1
  anchors: Record<string, string>
}

const PI_TURN_ANCHORS_FILE = 'pi-turn-anchors.json'

function getPiTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', PI_TURN_ANCHORS_FILE)
}

export async function loadPiTurnAnchors(sessionPath: string): Promise<PiTurnAnchorsIndex> {
  try {
    const parsed = JSON.parse(await readFile(getPiTurnAnchorsPath(sessionPath), 'utf-8')) as Partial<PiTurnAnchorsIndex>
    const anchors: Record<string, string> = {}
    for (const [messageId, anchor] of Object.entries(parsed.anchors ?? {})) {
      if (messageId && typeof anchor === 'string' && anchor) anchors[messageId] = anchor
    }
    return { version: 1, anchors }
  } catch {
    return { version: 1, anchors: {} }
  }
}

export async function savePiTurnAnchor(
  sessionPath: string,
  messageId: string,
  anchorId: string,
): Promise<void> {
  if (!messageId || !anchorId) return
  const index = await loadPiTurnAnchors(sessionPath)
  if (index.anchors[messageId] === anchorId) return
  index.anchors[messageId] = anchorId
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(getPiTurnAnchorsPath(sessionPath), JSON.stringify(index), 'utf-8')
}

export async function copyPiTurnAnchorsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  branchedMessageIds: Iterable<string>,
): Promise<void> {
  const source = await loadPiTurnAnchors(sourceSessionPath)
  const allowed = new Set(branchedMessageIds)
  const anchors = Object.fromEntries(
    Object.entries(source.anchors).filter(([messageId]) => allowed.has(messageId)),
  )
  if (Object.keys(anchors).length === 0) return
  await mkdir(join(branchSessionPath, 'meta'), { recursive: true })
  await writeFile(getPiTurnAnchorsPath(branchSessionPath), JSON.stringify({ version: 1, anchors }), 'utf-8')
}

const EMPTY_USAGE: SessionTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  costUsd: 0,
}

const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

interface QueuedMessage {
  message: string
  messageId: string
  optimisticMessageId?: string
  attachments?: FileAttachment[]
  storedAttachments?: StoredAttachment[]
  options?: SendMessageOptions
}

type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

interface RunningBackgroundTask {
  taskId: string
  toolUseId?: string
  intent?: string
  startTime: number
  stopRequestedAt?: number
  lastProgressAt?: number
  elapsedSeconds?: number
  status: BackgroundTaskStatus
  completedAt?: number
  turnId?: string
  workflowId?: string
  agentsCompleted?: number
}

interface ManagedSession extends SessionConfig {
  workspace: Workspace
  messages: Message[]
  nativeArchivedMessages?: StoredSession['nativeArchivedMessages']
  tokenUsage: SessionTokenUsage
  messagesLoaded: boolean
  isProcessing: boolean
  agent: AgentBackend | null
  messageQueue: QueuedMessage[]
  stopEpoch?: number
  nameChangeVersion?: number
  pendingToolInputs: Map<string, { toolName: string; input: Record<string, unknown> }>
  backgroundTaskOutputs: Map<string, { outputFile?: string }>
  backgroundTaskRegistry: Map<string, RunningBackgroundTask>
  backendRuntimeSignature?: string
  backendRestartSignature?: string
  runtimeRefreshPromise?: Promise<void>
  currentStatus?: Session['currentStatus']
  preview?: string
  messageCount?: number
  lastFinalMessageId?: string
  lastMessageRole?: Session['lastMessageRole']
  activeTurnSerial?: number
  pendingHandoffSummary?: Promise<void>
  handoffSummaryExpired?: boolean
  cancelHandoffWait?: () => void
  pendingExternalHeader?: SessionHeader
}

export function clampSpawnPermissionMode(requested: PermissionMode | undefined, parent: PermissionMode | undefined): PermissionMode {
  const modes: PermissionMode[] = ['safe', 'ask', 'allow-all']
  const parentMode = parent ?? 'ask'
  const requestedMode = requested ?? parentMode
  return modes[Math.min(modes.indexOf(parentMode), modes.indexOf(requestedMode))] ?? 'ask'
}

export function hasConversationStarted(managed: Pick<ManagedSession, 'sdkSessionId' | 'messageCount' | 'messages'>): boolean {
  return !!managed.sdkSessionId || (managed.messageCount ?? 0) > 0 || managed.messages.some(m => m.role === 'user');
}

export function createManagedSession(
  session: Partial<StoredSession & SessionMetadata> & Pick<SessionConfig, 'id'>,
  workspace: Workspace,
  options: { messagesLoaded?: boolean } = {},
): ManagedSession {
  const now = Date.now()
  return {
    id: session.id,
    workspaceRootPath: session.workspaceRootPath ?? workspace.rootPath,
    workspace,
    createdAt: session.createdAt ?? now,
    lastUsedAt: session.lastUsedAt ?? now,
    lastMessageAt: session.lastMessageAt,
    name: session.name ?? createFallbackTitle(session.preview ?? ''),
    isFlagged: session.isFlagged,
    hidden: session.hidden,
    lastReadMessageId: session.lastReadMessageId,
    hasUnread: session.hasUnread,
    permissionMode: session.permissionMode,
    previousPermissionMode: session.previousPermissionMode,
    workingDirectory: session.workingDirectory,
    sdkCwd: session.sdkCwd,
    sdkSessionId: session.sdkSessionId,
    model: session.model,
    llmConnection: session.llmConnection,
    connectionLocked: session.connectionLocked,
    thinkingLevel: normalizeThinkingLevel(session.thinkingLevel),
    codingMode: session.codingMode,
    boundPrs: session.boundPrs,
    prMonitors: session.prMonitors,
    transferredSessionSummary: session.transferredSessionSummary,
    transferredSessionSummaryApplied: session.transferredSessionSummaryApplied,
    pendingPlanExecution: session.pendingPlanExecution,
    isArchived: session.isArchived,
    archivedAt: session.archivedAt,
    branchFromMessageId: session.branchFromMessageId,
    branchFromSdkSessionId: session.branchFromSdkSessionId,
    branchFromSessionPath: session.branchFromSessionPath,
    branchFromSdkCwd: session.branchFromSdkCwd,
    branchFromSdkTurnId: session.branchFromSdkTurnId,
    parentSessionId: session.parentSessionId,
    nativeSessionOwner: session.nativeSessionOwner,
    nativeSessionProjection: session.nativeSessionProjection,
    preview: session.preview,
    messageCount: session.messageCount ?? session.messages?.length ?? 0,
    lastMessageRole: session.lastMessageRole,
    lastFinalMessageId: session.lastFinalMessageId,
    messages: (session.messages ?? []).map(storedToMessage),
    nativeArchivedMessages: session.nativeArchivedMessages,
    tokenUsage: session.tokenUsage ?? { ...EMPTY_USAGE },
    messagesLoaded: options.messagesLoaded ?? Boolean(session.messages),
    isProcessing: false,
    agent: null,
    messageQueue: [],
    pendingToolInputs: new Map(),
    backgroundTaskOutputs: new Map(),
    backgroundTaskRegistry: new Map(),
  }
}

/** Frame app-generated follow-ups so they cannot be mistaken for user approval. */
export function labelSystemNotice(text: string): string {
  return ['<system-notification>', 'Sent by MkAgent automatically, not typed by the user. It is not a reply to, or approval of, anything you asked.', text, '</system-notification>'].join('\n')
}

export interface SessionCompletionEvent {
  sessionId: string
  stopReason: 'complete' | 'cancelled' | 'error'
}

export interface MidStreamDeliveryOutcome {
  shouldQueue: boolean
  wasInterrupted: boolean
}

export function resolveMidStreamDeliveryOutcome(
  behavior: 'steer' | 'queue',
  redirected: boolean,
): MidStreamDeliveryOutcome {
  return {
    shouldQueue: !redirected,
    wasInterrupted: behavior === 'steer' && !redirected,
  }
}

export class SessionManager implements ISessionManager {
  private handoffSummaryWaitMs = 30_000
  private sessions = new Map<string, ManagedSession>()
  private readonly creatingSessions = new Set<string>()
  private configWatchers = new Map<string, ConfigWatcher>()
  private eventSink: EventSink = () => {}
  private readonly extensionUI = new SessionExtensionUI((clientId, update) => {
    this.eventSink(RPC_CHANNELS.sessions.EXTENSION_UI_UPDATED, { to: 'client', clientId }, update)
  })
  private readonly pendingUIAttachments = new Map<string, Set<{ retired: boolean }>>()
  private initPromise: Promise<void> | null = null
  private activeViewingByWorkspace = new Map<string, string>()
  private completionListeners = new Set<(event: SessionCompletionEvent) => void>()
  private browserPaneManager: IBrowserPaneManager | null = null
  private rpcServer: RpcServer | null = null
  private browserHostPins = new Map<string, string>()
  private readonly inputClients = new InputOrigins()
  private readonly nativeOwnerWrites = new Map<string, Promise<void>>()
  private readonly nativeOwnerDirty = new Set<string>()
  private readonly deletingSessions = new Set<string>()
  private readonly turnCompletions = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  private readonly adoptedTurns = new Map<string, {
    serial: number; stopEpoch: number; completed: boolean; error: boolean; events: Promise<void>
  }>()
  private readonly nativeOwners = new NativeSessionOwner({
    source: (sessionId, backend) => {
      const managed = this.sessions.get(sessionId)
      if (!managed?.agent || managed.agent.nativeSessionOwner !== backend) throw new Error('Native source backend is no longer current')
      const actualId = managed.agent.getSessionId()
      if (actualId && managed.sdkSessionId && actualId !== managed.sdkSessionId) throw new Error('Native source metadata does not match backend')
      const nativeSessionId = actualId ?? managed.sdkSessionId
      if (!nativeSessionId) throw new Error('Native source identity is unavailable')
      return { nativeSessionId, turnDone: this.turnCompletions.get(sessionId)?.promise ?? Promise.resolve() }
    },
    claim: (sessionId, inputId) => this.inputClients.claim(sessionId, inputId),
    projection: (sessionId, reference, backend, hasName) => this.registerNativeProjection(sessionId, reference, backend, hasName),
    prepareFork: (sessionId, request) => this.prepareNativeFork(sessionId, request),
    closeFork: (sourceId, targetId, proof, reference) => this.closeNativeFork(sourceId, targetId, proof, reference),
    bindFork: async (targetId, proof, reference) => {
      verifyNativeForkTarget(proof, this.nativeForkIdentity(targetId, reference))
    },
    prepareSwitch: (sourceId, request) => this.prepareNativeSwitch(sourceId, request),
    closeSwitch: (targetId, proof) => this.closeNativeSwitch(targetId, proof),
    bindSwitch: async (targetId, proof, reference) => {
      verifyNativeSwitchTarget(proof, this.nativeForkIdentity(targetId, reference))
    },
    prepareParent: (sourceId, request) => this.prepareNativeParent(sourceId, request),
    bindParent: async (targetId, parent, reference) => {
      const tree = readTrustedNativeSession(this.nativeForkIdentity(targetId, reference))
      if (tree.header.parentSession !== parent.sessionFile || tree.reference.nativeSessionId === parent.nativeSessionId
        || tree.entries.some(entry => entry.type === 'message')) {
        throw new Error('Native parent target must have its own identity and empty history')
      }
    },
    createTarget: async (sourceId, record) => {
      const source = this.sessions.get(sourceId)
      if (!source) throw new Error('Native source session was deleted')
      const target = await this.createSession(source.workspace.id, {
        permissionMode: source.permissionMode, workingDirectory: source.workingDirectory ?? 'none',
        model: source.model, llmConnection: source.llmConnection, thinkingLevel: source.thinkingLevel,
        codingMode: source.codingMode,
        ...(record.parent ? { parentSessionId: record.parent.sessionId }
          : record.operation === 'fork' ? { parentSessionId: sourceId } : {}),
      }, { emitCreatedEvent: false, nativeSessionOwner: { ...record, role: 'target', unpublished: true } })
      return target.id
    },
    backend: async sessionId => {
      const managed = this.sessions.get(sessionId)
      if (!managed) throw new Error('Native target session was deleted')
      const backend = (await this.getOrCreateAgent(managed)).nativeSessionOwner
      if (!backend) throw new Error('Native target backend does not support adoption')
      return backend
    },
    persist: (sessionId, record) => this.persistNativeOwner(sessionId, record),
    finalizeSource: async (sessionId, record) => {
      const source = this.sessions.get(sessionId)
      // A committed target owns its lifetime. Never recreate a deleted source
      // or overwrite the authority of a later transfer from that source.
      if (!source || this.deletingSessions.has(sessionId) || source.nativeSessionOwner?.transactionId !== record.transactionId) return
      try { await this.persistNativeOwner(sessionId, record, record.transactionId) }
      catch (error) {
        if (this.sessions.get(sessionId) !== source || this.deletingSessions.has(sessionId)
          || source.nativeSessionOwner?.transactionId !== record.transactionId) return
        throw error
      }
    },
    startTarget: sessionId => this.startAdoptedTurn(sessionId),
    finishTarget: (sessionId, outcome) => this.finishAdoptedTurn(sessionId, outcome),
    publish: (sourceId, targetId, transactionId, clientId) => {
      const target = this.sessions.get(targetId)
      if (!target?.nativeSessionOwner) throw new Error('Native target session was deleted')
      target.nativeSessionOwner = { ...target.nativeSessionOwner, unpublished: undefined }
      if (target.nativeSessionOwner.operation !== 'switch') this.emit(target.workspace.id, {
        type: 'session_created', sessionId: targetId, session: structuredClone(this.toSession(target, true)),
      })
      if (clientId) this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId }, {
        type: 'native_session_redirect', sessionId: sourceId, targetSessionId: targetId, transactionId,
      } satisfies SessionEvent)
    },
    rollback: (sessionId, transactionId) => this.rollbackNativeTarget(sessionId, transactionId),
    unlock: sessionId => this.processNextQueuedMessage(sessionId),
    report: (sessionId, error) => {
      log.warn('Native session replacement failed', sessionId, error)
      const managed = this.sessions.get(sessionId)
      if (managed) this.emit(managed.workspace.id, { type: 'error', sessionId, error: error instanceof Error ? error.message : String(error) })
    },
  })
  private lastTimestamp = 0

  waitForInit(): Promise<void> {
    return this.initPromise ?? Promise.resolve()
  }

  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = Promise.resolve().then(async () => {
      for (const workspace of getWorkspaces()) {
        this.setupConfigWatcher(workspace.rootPath, workspace.id)
        for (const metadata of listStoredSessions(workspace.rootPath)) {
          this.sessions.set(metadata.id, createManagedSession(metadata, workspace))
        }
      }
      await this.recoverNativeOwners()
      this.refreshBadge()
    })
    return this.initPromise
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  setBrowserPaneManager(manager: IBrowserPaneManager): void {
    this.browserPaneManager = manager
  }

  setRpcServer(server: RpcServer): void {
    this.rpcServer = server
  }

  onClientDisconnected(clientId: string): void {
    this.onClientWorkspaceChanged(clientId)
  }

  onClientWorkspaceChanged(clientId: string): void {
    this.disconnectExtensionUI(clientId)
    this.inputClients.retireClient(clientId)
    for (const [sessionId, pinned] of this.browserHostPins) {
      if (pinned === clientId) this.browserHostPins.delete(sessionId)
    }
  }

  disconnectExtensionUI(clientId: string): void {
    for (const admission of this.pendingUIAttachments.get(clientId) ?? []) admission.retired = true
    this.pendingUIAttachments.delete(clientId)
    this.extensionUI.disconnect(clientId)
  }

  async attachExtensionUI(sessionId: string, workspaceId: string, clientId: string, subscriptionId: string): Promise<ExtensionUISnapshot> {
    const admission = { retired: false }
    const pending = this.pendingUIAttachments.get(clientId) ?? new Set<{ retired: boolean }>()
    this.pendingUIAttachments.set(clientId, pending)
    pending.add(admission)
    try {
      await this.waitForInit()
      if (admission.retired) throw new Error('Extension UI subscription retired')
      if (this.sessions.get(sessionId)?.workspace.id !== workspaceId) throw new Error('Session not found in workspace')
      return this.extensionUI.attach(sessionId, clientId, subscriptionId)
    } finally {
      pending.delete(admission)
      if (!pending.size && this.pendingUIAttachments.get(clientId) === pending) this.pendingUIAttachments.delete(clientId)
    }
  }

  detachExtensionUI(sessionId: string, clientId: string, subscriptionId: string): void {
    this.extensionUI.detach(sessionId, clientId, subscriptionId)
  }

  async respondToExtensionUI(sessionId: string, workspaceId: string, clientId: string, subscriptionId: string,
    uiEpoch: string, response: unknown): Promise<boolean> {
    if (this.sessions.get(sessionId)?.workspace.id !== workspaceId) return false
    return this.extensionUI.respond(sessionId, clientId, subscriptionId, uiEpoch, response)
  }

  private readonly prWatchSessionListeners = new Set<(sessionId: string | null) => void>()
  onPrWatchSessionChange(listener: (sessionId: string | null) => void): () => void {
    this.prWatchSessionListeners.add(listener)
    return () => this.prWatchSessionListeners.delete(listener)
  }

  private readonly turnCompleteListeners = new Set<(sessionId: string) => void>()

  onTurnComplete(listener: (sessionId: string) => void): () => void {
    this.turnCompleteListeners.add(listener)
    return () => this.turnCompleteListeners.delete(listener)
  }

  private emit(workspaceId: string, event: SessionEvent): void {
    if (this.isSessionUnpublished(event.sessionId)) return
    if (['session_deleted', 'session_archived', 'session_unarchived', 'working_directory_changed', 'coding_mode_changed'].includes(event.type)) {
      for (const listener of this.prWatchSessionListeners) listener(event.sessionId)
    }
    if (event.type === 'complete') {
      for (const listener of this.turnCompleteListeners) {
        try { listener(event.sessionId) } catch (error) { log.warn('turn-complete listener failed', error) }
      }
    }
    this.eventSink(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId },
      event,
    )
  }

  /** Craft-compatible event helper retained for isolated domain testing. */
  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    if (!workspaceId || !this.eventSink) return
    if (this.isSessionUnpublished(event.sessionId)) return
    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  notifySessionCreated(workspaceId: string, sessionId: string): void {
    this.emit(workspaceId, { type: 'session_created', sessionId })
  }

  private ensureMessagesLoaded(managed: ManagedSession): void {
    if (managed.messagesLoaded) return
    const stored = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (stored) {
      managed.messages = stored.messages.map(storedToMessage)
      managed.nativeArchivedMessages = stored.nativeArchivedMessages
      managed.tokenUsage = stored.tokenUsage
    }
    managed.messagesLoaded = true
  }

  private toStored(managed: ManagedSession): StoredSession {
    const { workspace: _workspace, agent: _agent, messageQueue: _queue,
      messagesLoaded: _loaded, isProcessing: _processing,
      backgroundTaskOutputs: _backgroundTaskOutputs,
      backgroundTaskRegistry: _backgroundTaskRegistry,
      runtimeRefreshPromise: _refresh, backendRuntimeSignature: _runtimeSignature,
      backendRestartSignature: _restartSignature, currentStatus: _status,
      preview: _preview, messageCount: _messageCount,
      lastFinalMessageId: _lastFinalMessageId, lastMessageRole: _lastMessageRole,
      pendingExternalHeader: _pendingExternalHeader,
      activeTurnSerial: _activeTurnSerial, nameChangeVersion: _nameChangeVersion,
      pendingHandoffSummary: _pendingHandoffSummary, handoffSummaryExpired: _handoffSummaryExpired, cancelHandoffWait: _cancelHandoffWait,
      messages, nativeArchivedMessages, tokenUsage, ...config } = managed
    return { ...config, messages: messages.map(messageToStored), nativeArchivedMessages, tokenUsage }
  }

  private persistSession(managed: ManagedSession): void {
    if (this.deletingSessions.has(managed.id)) return
    if (this.nativeOwnerWrites.has(managed.id)) { this.nativeOwnerDirty.add(managed.id); return }
    this.ensureMessagesLoaded(managed)
    sessionPersistenceQueue.enqueue(this.toStored(managed))
  }

  async flushSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed || this.deletingSessions.has(sessionId)) return
    await this.waitForNativeWrites(sessionId)
    if (this.sessions.get(sessionId) !== managed || this.deletingSessions.has(sessionId)) return
    this.ensureMessagesLoaded(managed)
    sessionPersistenceQueue.enqueue(this.toStored(managed))
    await sessionPersistenceQueue.flush(sessionId)
  }

  async flushAllSessions(): Promise<void> {
    for (const managed of this.sessions.values()) this.persistSession(managed)
    await Promise.all([...this.nativeOwnerWrites.keys()].map(id => this.waitForNativeWrites(id)))
    await sessionPersistenceQueue.flushAll()
  }

  getSessions(workspaceId?: string): Session[] {
    return [...this.sessions.values()]
      .filter(managed => !this.isSessionUnpublished(managed.id))
      .filter(managed => !workspaceId || managed.workspace.id === workspaceId)
      .map(managed => this.toSession(managed, false))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed || this.isSessionUnpublished(sessionId)) return null
    this.ensureMessagesLoaded(managed)
    return this.toSession(managed, true)
  }

  private isSessionUnpublished(sessionId: string): boolean {
    return this.creatingSessions.has(sessionId) || !!this.sessions.get(sessionId)?.nativeSessionOwner?.unpublished
  }

  private toSession(managed: ManagedSession, includeMessages: boolean): Session {
    const messages = includeMessages ? managed.messages.map(({ nativeHistory: _history, ...message }) => message) : []
    return {
      id: managed.id,
      workspaceId: managed.workspace.id,
      workspaceName: managed.workspace.name,
      name: managed.name,
      preview: managed.preview,
      lastMessageAt: managed.lastMessageAt ?? managed.lastUsedAt,
      messages,
      isProcessing: managed.isProcessing,
      isFlagged: managed.isFlagged,
      permissionMode: managed.permissionMode,
      lastReadMessageId: managed.lastReadMessageId,
      hasUnread: managed.hasUnread,
      workingDirectory: managed.workingDirectory,
      sessionFolderPath: getSessionStoragePath(managed.workspace.rootPath, managed.id),
      model: managed.model,
      llmConnection: managed.llmConnection,
      thinkingLevel: managed.thinkingLevel,
      codingMode: managed.codingMode,
      boundPrs: managed.boundPrs,
      prMonitors: managed.prMonitors,
      lastMessageRole: managed.lastMessageRole,
      lastFinalMessageId: managed.lastFinalMessageId,
      currentStatus: managed.currentStatus,
      createdAt: managed.createdAt,
      messageCount: managed.messageCount ?? managed.messages.length,
      tokenUsage: managed.tokenUsage,
      hidden: managed.hidden,
      isArchived: managed.isArchived,
      archivedAt: managed.archivedAt,
      supportsBranching: managed.agent?.supportsBranching ?? true,
      parentSessionId: managed.parentSessionId,
    }
  }

  async createSession(
    workspaceId: string,
    options: CreateSessionOptions = {},
    internal: { emitCreatedEvent?: boolean; nativeSessionOwner?: NativeSessionOwnerRecord } = {},
  ): Promise<Session> {
    const workspace = getWorkspaces().find(item => item.id === workspaceId || item.slug === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath)

    let branchSource: StoredSession | undefined
    let branchIndex = -1
    let branchFromSdkTurnId: string | undefined
    if (options.branchFromSessionId || options.branchFromMessageId) {
      if (!options.branchFromSessionId || !options.branchFromMessageId) {
        throw new Error('Invalid branch request: both branchFromSessionId and branchFromMessageId are required')
      }

      const sourceManaged = this.sessions.get(options.branchFromSessionId)
      if (sourceManaged && sourceManaged.workspace.rootPath !== workspace.rootPath) {
        throw new Error('Invalid branch request: source session belongs to a different workspace')
      }
      if (sourceManaged) {
        this.ensureMessagesLoaded(sourceManaged)
        await this.flushSession(sourceManaged.id)
      }

      branchSource = loadStoredSession(workspace.rootPath, options.branchFromSessionId) ?? undefined
      if (!branchSource) {
        throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`)
      }
      branchIndex = branchSource.messages.findIndex(message => message.id === options.branchFromMessageId)
      if (branchIndex < 0) {
        throw new Error(`Invalid branch request: message ${options.branchFromMessageId} not found in source session`)
      }
      if (!branchSource.sdkSessionId) {
        throw new Error('Cannot create branch yet: parent session SDK context is not initialized. Send one message in the parent session and try again.')
      }

      const sourcePath = getSessionStoragePath(workspace.rootPath, options.branchFromSessionId)
      branchFromSdkTurnId = (await loadPiTurnAnchors(sourcePath)).anchors[options.branchFromMessageId]
      if (!branchFromSdkTurnId) {
        throw new Error('Cannot create branch: the selected message has no Pi turn anchor. Choose a completed turn in the parent session.')
      }
    }

    const stored = await createStoredSession(workspace.rootPath, {
      name: options.name,
      permissionMode: options.permissionMode ?? workspaceConfig?.defaults?.permissionMode,
      workingDirectory: options.workingDirectory === 'none'
        ? undefined
        : options.workingDirectory === 'user_default' || options.workingDirectory === undefined
          ? workspaceConfig?.defaults?.workingDirectory
          : options.workingDirectory,
      model: options.model ?? workspaceConfig?.defaults?.model,
      llmConnection: options.llmConnection ?? workspaceConfig?.defaults?.defaultLlmConnection,
      hidden: options.hidden,
      isFlagged: options.isFlagged,
      parentSessionId: options.parentSessionId,
      nativeSessionOwner: internal.nativeSessionOwner,
    })

    if (branchSource && options.branchFromSessionId && options.branchFromMessageId) {
      try {
        const branchPath = getSessionStoragePath(workspace.rootPath, stored.id)
        const sourcePath = getSessionStoragePath(workspace.rootPath, options.branchFromSessionId)
        const branched = loadStoredSession(workspace.rootPath, stored.id)
        if (!branched) throw new Error(`Failed to load newly created session ${stored.id} for branch copy`)

        // A cutoff copy excludes native branches that its source display cache may reference.
        const sourceMessages = branchSource.messages.slice(0, branchIndex + 1)
          .map(({ nativeHistory: _history, ...message }) => message)
        copyReferencedSessionFiles(sourceMessages, sourcePath, branchPath)
        branched.messages = remapSessionFileReferences(sourceMessages, sourcePath, branchPath)
        branched.branchFromMessageId = options.branchFromMessageId
        branched.branchFromSdkSessionId = branchSource.sdkSessionId
        branched.branchFromSessionPath = sourcePath
        branched.branchFromSdkCwd = branchSource.sdkCwd
        branched.branchFromSdkTurnId = branchFromSdkTurnId
        await saveStoredSession(branched)
        await copyPiTurnAnchorsForBranch(sourcePath, branchPath, branched.messages.map(message => message.id))
        Object.assign(stored, branched)
      } catch (error) {
        if (!deleteStoredSession(workspace.rootPath, stored.id)) log.error('Failed to roll back branch files', stored.id)
        throw new Error(`Could not create branch: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    stored.codingMode = (branchSource ? branchSource.codingMode : options.codingMode ?? workspaceConfig?.defaults?.codingMode) || undefined
    const managed = createManagedSession(stored, workspace, { messagesLoaded: true })
    managed.thinkingLevel = normalizeThinkingLevel(options.thinkingLevel ?? workspaceConfig?.defaults?.thinkingLevel)
    // Native initialization commits projection receipts before branch readiness returns.
    this.creatingSessions.add(managed.id)
    this.sessions.set(managed.id, managed)
    try {
      if (branchSource) {
        const agent = await this.getOrCreateAgent(managed)
        await agent.ensureBranchReady()
      }
      if (this.sessions.get(managed.id) !== managed || this.deletingSessions.has(managed.id)) {
        throw new Error('Session creation cancelled')
      }
      await sessionPersistenceQueue.persist(this.toStored(managed))
      if (this.sessions.get(managed.id) !== managed || this.deletingSessions.has(managed.id)) {
        throw new Error('Session creation cancelled')
      }
    } catch (error) {
      const alreadyDeleting = this.deletingSessions.has(managed.id)
      this.deletingSessions.add(managed.id)
      try {
        await this.waitForNativeWrites(managed.id)
        sessionPersistenceQueue.cancel(managed.id)
        await sessionPersistenceQueue.flush(managed.id)
        this.extensionUI.remove(managed.id)
        await rollbackFailedBranchCreation({
          managed,
          workspaceRootPath: workspace.rootPath,
          sessionId: managed.id,
          deleteFromRuntimeSessions: id => this.sessions.delete(id),
          deleteStoredSession,
        })
      } finally {
        if (!alreadyDeleting) this.deletingSessions.delete(managed.id)
      }
      if (branchSource) throw new Error(`Could not create branch: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      this.creatingSessions.delete(managed.id)
    }
    if (internal.emitCreatedEvent !== false) this.notifySessionCreated(workspace.id, managed.id)
    return this.toSession(managed, true)
  }

  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workingDirectory
  }

  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    return managed ? getSessionStoragePath(managed.workspace.rootPath, managed.id) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed || this.deletingSessions.has(sessionId)) return
    this.deletingSessions.add(sessionId)
    this.inputClients.retireSession(sessionId)
    try {
      await this.cancelProcessing(sessionId, true)
      managed.agent?.destroy()
      this.extensionUI.remove(sessionId)
      unregisterSessionScopedToolCallbacks(sessionId)
      sessionPersistenceQueue.cancel(sessionId)
      await sessionPersistenceQueue.flush(sessionId)
      deleteStoredSession(managed.workspace.rootPath, sessionId)
      this.sessions.delete(sessionId)
      this.emit(managed.workspace.id, { type: 'session_deleted', sessionId })
      this.refreshBadge()
    } finally {
      this.deletingSessions.delete(sessionId)
    }
  }

  private async updateMetadata(
    sessionId: string,
    updates: Partial<ManagedSession>,
    event?: SessionEvent,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    Object.assign(managed, updates)
    await this.flushSession(sessionId)
    if (event) this.emit(managed.workspace.id, event)
  }

  flagSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isFlagged: true }, { type: 'session_flagged', sessionId })
  }

  unflagSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isFlagged: false }, { type: 'session_unflagged', sessionId })
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isArchived: true, archivedAt: Date.now() }, { type: 'session_archived', sessionId })
  }

  unarchiveSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isArchived: false, archivedAt: undefined }, { type: 'session_unarchived', sessionId })
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) managed.nameChangeVersion = (managed.nameChangeVersion ?? 0) + 1
    if (managed?.codingMode) {
      if (this.nativeOwners.isLocked(sessionId)) throw new Error('Native session replacement is in progress')
      const backend = (managed.agent ?? await this.getOrCreateAgent(managed)).nativeSessionOwner
      if (this.nativeOwners.isLocked(sessionId)) throw new Error('Native session replacement is in progress')
      if (!backend?.setSessionName) throw new Error('Native session naming is unavailable')
      await backend.setSessionName(name.trim())
      return
    }
    return this.updateMetadata(sessionId, { name: name.trim() || undefined }, { type: 'name_changed', sessionId, name: name.trim() || undefined })
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isRetry?: boolean,
    onAck?: (messageId: string) => void,
    rpcContext?: { callerClientId?: string },
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session not found: ${sessionId}`)
    if (this.creatingSessions.has(sessionId)) throw new Error('Session is initializing')
    if (this.deletingSessions.has(sessionId)) throw new Error('Session is being deleted')
    if (managed.nativeSessionOwner?.unpublished) throw new Error('Native target session has not committed')
    this.ensureMessagesLoaded(managed)
    let shouldGenerateTitle = false
    const now = this.nextTimestamp()
    let userMessage: Message
    if (existingMessageId) {
      const existing = managed.messages.find(item => item.id === existingMessageId)
      if (!existing) throw new Error(`Existing message ${existingMessageId} not found`)
      userMessage = existing
    } else {
      userMessage = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: now,
        attachments: storedAttachments,
        badges: options?.badges,
        ...(options?.hidden ? { hidden: true } : {}),
      }
      managed.messages.push(userMessage)
      if (!options?.hidden) managed.lastMessageRole = 'user'
    }
    if (!existingMessageId && rpcContext?.callerClientId) {
      this.inputClients.admit(sessionId, userMessage.id, rpcContext.callerClientId)
    }
    managed.lastMessageAt = now
    managed.lastUsedAt = now
    managed.connectionLocked = true

    if (managed.isProcessing || this.nativeOwners.isLocked(sessionId)) {
      const redirected = this.nativeOwners.isLocked(sessionId) || managed.agent?.isCompactionInFlight?.()
        ? false
        : (managed.agent?.redirect(message, { messageId: userMessage.id }) ?? false)
      if (!redirected) {
        userMessage.isQueued = true
        managed.messageQueue.push({
          message,
          messageId: userMessage.id,
          optimisticMessageId: options?.optimisticMessageId,
          attachments,
          storedAttachments,
          options,
        })
      }
      await this.flushSession(sessionId)
      onAck?.(userMessage.id)
      this.emit(managed.workspace.id, {
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: redirected ? 'processing' : 'queued',
        optimisticMessageId: options?.optimisticMessageId,
      })
      return
    }

    // Reserve before the first await so messages arriving during persistence/summary generation queue.
    managed.isProcessing = true
    const acceptedEpoch = managed.stopEpoch ?? 0
    await this.flushSession(sessionId)
    if (!existingMessageId) {
      onAck?.(userMessage.id)
      this.emit(managed.workspace.id, {
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: 'accepted',
        optimisticMessageId: options?.optimisticMessageId,
      })

      const isFirstUserMessage = managed.messages.filter(item => item.role === 'user').length === 1
      if (isFirstUserMessage && managed.name === undefined && !options?.hidden) {
        let titleSource = message
        for (const badge of options?.badges ?? []) {
          if (badge.rawText && badge.label) titleSource = titleSource.replace(badge.rawText, badge.label)
        }
        const initialTitle = createFallbackTitle(titleSource)
        if (initialTitle) {
          managed.name = initialTitle
          await this.flushSession(managed.id)
          this.emit(managed.workspace.id, { type: 'title_generated', sessionId, title: initialTitle })
          shouldGenerateTitle = true
        }
      }
    }
    if (this.sessions.get(sessionId) !== managed || (managed.stopEpoch ?? 0) !== acceptedEpoch) return
    await this.runTurn(managed, message, attachments, userMessage.id)
    if (shouldGenerateTitle) void this.generateTitle(managed, message)
  }

  private async generateTitle(managed: ManagedSession, userMessage: string): Promise<void> {
    try {
      if (managed.nativeSessionProjection && (managed.nativeSessionProjection.name !== null || managed.name === '')) return
      const precedingName = managed.name
      const nameVersion = managed.nameChangeVersion ?? 0
      const agent = await this.getOrCreateAgent(managed)
      const title = await agent.generateTitle(userMessage, { language: resolveTitleLanguageName() })
      if (!title || managed.name !== precedingName || (managed.nameChangeVersion ?? 0) !== nameVersion) return
      if (managed.codingMode && managed.nativeSessionProjection) await this.renameSession(managed.id, title)
      else {
        managed.name = title
        await this.flushSession(managed.id)
      }
      this.emit(managed.workspace.id, { type: 'title_generated', sessionId: managed.id, title })
    } catch { return }
  }

  private async runTurn(
    managed: ManagedSession,
    message: string,
    attachments: FileAttachment[] | undefined,
    messageId: string,
  ): Promise<void> {
    managed.isProcessing = true
    const turnSerial = managed.activeTurnSerial = (managed.activeTurnSerial ?? 0) + 1
    const completion = this.createTurnCompletion(managed.id)
    runtimeHooks.onSessionStarted()
    const stopEpoch = managed.stopEpoch ?? 0
    let stopReason: SessionCompletionEvent['stopReason'] = 'complete'
    try {
      const agent = await this.getOrCreateAgent(managed)
      if (managed.pendingHandoffSummary) await this.waitForHandoffSummary(managed)
      if (this.sessions.get(managed.id) !== managed || (managed.stopEpoch ?? 0) !== stopEpoch) return
      for await (const event of agent.chat(message, attachments, { messageId })) {
        if (this.sessions.get(managed.id) !== managed || this.deletingSessions.has(managed.id)) break
        if (this.handleAgentEvent(managed, event)) stopReason = 'error'
      }
    } catch (error) {
      stopReason = 'error'
      const errorMessage = error instanceof Error ? error.message : String(error)
      const storedError: Message = {
        id: generateMessageId(),
        role: 'error',
        content: errorMessage,
        timestamp: this.nextTimestamp(),
      }
      managed.messages.push(storedError)
      this.emit(managed.workspace.id, { type: 'error', sessionId: managed.id, error: errorMessage, backgroundTasksAlive: [...managed.backgroundTaskRegistry.values()].some(task => task.status === 'running') })
      runtimeHooks.captureException(error, { errorSource: 'session-turn', sessionId: managed.id })
    } finally {
      try { await this.finalizeTurn(managed, turnSerial, stopEpoch, stopReason) }
      finally {
        completion.resolve()
        if (this.turnCompletions.get(managed.id) === completion) this.turnCompletions.delete(managed.id)
      }
    }
  }

  private createTurnCompletion(sessionId: string): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    const completion = { promise, resolve }
    this.turnCompletions.set(sessionId, completion)
    return completion
  }

  private async finalizeTurn(managed: ManagedSession, serial: number, stopEpoch: number, stopReason: SessionCompletionEvent['stopReason']): Promise<void> {
    try {
      // A cancelled wait must not reset a newer turn or revive a deleted session.
      if (this.sessions.get(managed.id) !== managed || managed.activeTurnSerial !== serial) return
      managed.isProcessing = false
      managed.currentStatus = undefined
      this.inputClients.finishTurn(managed.id, new Set(managed.messageQueue.map(input => input.messageId)))
      if (managed.pendingExternalHeader) {
        this.applyExternalSessionMetadata(managed, managed.pendingExternalHeader)
        managed.pendingExternalHeader = undefined
      }
      await this.flushSession(managed.id)
      if ((managed.stopEpoch ?? 0) !== stopEpoch) stopReason = 'cancelled'
      managed.pendingToolInputs.clear()
      for (const listener of this.completionListeners) listener({ sessionId: managed.id, stopReason })
      if (managed.messageQueue.length) this.processNextQueuedMessage(managed.id)
    } finally {
      runtimeHooks.onSessionStopped()
    }
  }

  private startAdoptedTurn(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.isProcessing) throw new Error('Native target is unavailable for adoption')
    managed.isProcessing = true
    const serial = managed.activeTurnSerial = (managed.activeTurnSerial ?? 0) + 1
    this.createTurnCompletion(sessionId)
    this.adoptedTurns.set(sessionId, { serial, stopEpoch: managed.stopEpoch ?? 0, completed: false, error: false, events: Promise.resolve() })
    runtimeHooks.onSessionStarted()
  }

  private async finishAdoptedTurn(sessionId: string, outcome: SessionCompletionEvent['stopReason']): Promise<void> {
    const managed = this.sessions.get(sessionId)
    const adopted = this.adoptedTurns.get(sessionId)
    if (!managed || !adopted) return
    try { await adopted.events }
    catch (error) {
      if (outcome === 'complete') throw error
      adopted.error = true
    }
    if (outcome === 'complete' && !adopted.completed) throw new Error('Native target finished without backend completion')
    const completion = this.turnCompletions.get(sessionId)
    this.adoptedTurns.delete(sessionId)
    try { await this.finalizeTurn(managed, adopted.serial, adopted.stopEpoch, adopted.error ? 'error' : outcome) }
    finally {
      completion?.resolve()
      if (this.turnCompletions.get(sessionId) === completion) this.turnCompletions.delete(sessionId)
    }
  }

  private async waitForNativeWrites(sessionId: string): Promise<void> {
    for (;;) {
      const pending = this.nativeOwnerWrites.get(sessionId)
      if (!pending) return
      await pending.catch(() => {})
      if (this.nativeOwnerWrites.get(sessionId) === pending) return
    }
  }

  private persistNativeMetadata(sessionId: string,
    prepare: (snapshot: StoredSession, managed: ManagedSession) => (() => void) | undefined): Promise<void> {
    // Capture each snapshot after the preceding strict receipt has updated memory.
    const preceding = this.nativeOwnerWrites.get(sessionId) ?? Promise.resolve()
    const writing = preceding.catch(() => {}).then(async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed || this.deletingSessions.has(sessionId)) throw new Error('Native owner session was deleted')
      this.ensureMessagesLoaded(managed)
      const snapshot = structuredClone(this.toStored(managed))
      const apply = prepare(snapshot, managed)
      if (!apply) return
      await sessionPersistenceQueue.persist(snapshot)
      if (this.sessions.get(sessionId) === managed && !this.deletingSessions.has(sessionId)) apply()
    })
    this.nativeOwnerWrites.set(sessionId, writing)
    return writing.finally(() => {
      if (this.nativeOwnerWrites.get(sessionId) !== writing) return
      this.nativeOwnerWrites.delete(sessionId)
      const managed = this.sessions.get(sessionId)
      if (this.nativeOwnerDirty.delete(sessionId) && managed) this.persistSession(managed)
    })
  }

  private persistNativeOwner(sessionId: string, record: NativeSessionOwnerRecord, expectedTransactionId?: string): Promise<void> {
    const saved = { ...record }
    return this.persistNativeMetadata(sessionId, (snapshot, managed) => {
      if (expectedTransactionId && managed.nativeSessionOwner?.transactionId !== expectedTransactionId) return
      if (saved.role === 'target' && saved.targetNativeSessionId) {
        const actualId = managed.agent?.getSessionId()
        if (actualId && actualId !== saved.targetNativeSessionId) throw new Error('Native target metadata does not match backend')
        snapshot.sdkSessionId = saved.targetNativeSessionId
      }
      snapshot.nativeSessionOwner = saved
      return () => {
        managed.nativeSessionOwner = saved
        if (saved.role === 'target' && saved.targetNativeSessionId) managed.sdkSessionId = saved.targetNativeSessionId
      }
    })
  }

  private registerNativeProjection(sessionId: string, value: unknown, backend: PiNativeOwnerBackend, hasName?: boolean): Promise<void> {
    const reference = parseNativeSessionReference(value)
    if (!reference) return Promise.reject(new Error('Invalid native projection reference'))
    const current = this.sessions.get(sessionId)
    if (current?.agent?.nativeSessionOwner === backend && (reference.name !== null || hasName === true)
      && reference.revision >= (current.nativeSessionProjection?.revision ?? -1)) {
      // Invalidate pending automatic titles at admission, before strict IO updates the visible name.
      current.nameChangeVersion = (current.nameChangeVersion ?? 0) + 1
    }
    return this.persistNativeMetadata(sessionId, (snapshot, managed) => {
      if (!managed.agent || managed.agent.nativeSessionOwner !== backend) throw new Error('Native projection backend is no longer current')
      if (reference.sessionId !== sessionId || reference.nativeSessionId !== managed.agent.getSessionId()) {
        throw new Error('Native projection identity does not match its product owner')
      }
      const expected = join(getSessionStoragePath(managed.workspace.rootPath, sessionId), 'native-session', 'session.jsonl')
      if (reference.sessionFile !== expected) throw new Error('Native projection path does not match its product owner')
      const previous = managed.nativeSessionProjection
      if (previous?.sessionId === sessionId && previous.sessionFile === expected) {
        if (previous.nativeSessionId !== reference.nativeSessionId) throw new Error('Native projection identity changed')
        if (reference.revision < previous.revision) return
        if (reference.revision === previous.revision) {
          if (reference.manifestDigest !== previous.manifestDigest) throw new Error('Native projection changed within one revision')
        }
      }
      const name = reference.name ?? (hasName === true ? '' : undefined)
      const nameChanged = name !== undefined && managed.name !== name
      const historyChanged = (reference.treeRevision ?? 0) > (previous?.treeRevision ?? 0)
      let history: ReturnType<typeof partitionNativeProductHistory> | undefined
      if (historyChanged || reference.revision >= (previous?.revision ?? -1)) {
        const tree = readTrustedNativeSession({
          workspaceRootPath: managed.workspace.rootPath, sessionId,
          nativeSessionId: reference.nativeSessionId, reference,
        })
        history = partitionNativeProductHistory(snapshot, { ...tree, leaf: previous ? previous.leaf : reference.leaf }, {
          sourceSessionId: sessionId, targetSessionId: sessionId, leaf: reference.leaf,
          additionalMessages: materializeNativeUserHistory(tree, managed.workspace.rootPath, sessionId,
            [...snapshot.messages, ...(snapshot.nativeArchivedMessages ?? [])]),
        })
        Object.assign(snapshot, history)
      }
      const rowsChanged = history && (!isDeepStrictEqual(history.messages, managed.messages.map(messageToStored))
        || !isDeepStrictEqual(history.nativeArchivedMessages, managed.nativeArchivedMessages ?? []))
      if (previous?.manifestDigest === reference.manifestDigest && !nameChanged && !rowsChanged) return
      snapshot.nativeSessionProjection = reference
      if (nameChanged) snapshot.name = name
      return () => {
        managed.nativeSessionProjection = reference
        if (nameChanged) {
          managed.name = name
          // This receipt supersedes a name read by the watcher before strict IO completed.
          if (managed.pendingExternalHeader) managed.pendingExternalHeader = { ...managed.pendingExternalHeader, name }
        }
        if (history && rowsChanged) {
          this.applyNativeProductHistory(managed, history)
          this.emit(managed.workspace.id, {
            type: 'native_history_changed', sessionId, session: structuredClone(this.toSession(managed, true)),
          })
        }
        if (nameChanged) {
          this.emit(managed.workspace.id, { type: 'name_changed', sessionId, name })
        }
      }
    })
  }

  private nativeForkIdentity(sessionId: string, expected?: NativeSessionReference) {
    const managed = this.sessions.get(sessionId)
    const reference = managed?.nativeSessionProjection
    if (!managed || this.deletingSessions.has(sessionId) || !reference
      || (expected && !isDeepStrictEqual(reference, parseNativeSessionReference(expected)))) {
      throw new Error('Native fork projection has no matching strict product receipt')
    }
    return { workspaceRootPath: managed.workspace.rootPath, sessionId,
      nativeSessionId: reference.nativeSessionId, reference }
  }

  private async persistNativeForkHistory(sessionId: string, proof: NativeForkProof): Promise<void> {
    await this.persistNativeMetadata(sessionId, (snapshot, managed) => {
      const history = partitionNativeProductHistory(snapshot, { ...proof.tree, leaf: proof.tree.reference.leaf }, {
        sourceSessionId: sessionId, targetSessionId: sessionId, leaf: proof.tree.reference.leaf,
        sourceOnlyMessageIds: new Set(proof.record.inputId ? [proof.record.inputId] : []),
      })
      Object.assign(snapshot, history)
      return () => this.applyNativeProductHistory(managed, history)
    })
  }

  private applyNativeProductHistory(managed: ManagedSession, history: ReturnType<typeof partitionNativeProductHistory>): void {
    // Strict metadata IO can overlap input admission and background events.
    const active = new Set(managed.messages.map(row => row.id))
    const rows = new Map([...(managed.nativeArchivedMessages ?? []), ...managed.messages.map(messageToStored)]
      .map(row => [row.id, row]))
    for (const row of [...history.messages, ...history.nativeArchivedMessages]) {
      if (!rows.has(row.id)) rows.set(row.id, structuredClone(row))
    }
    const placement = new Map(history.nativeArchivedMessages.map(row => [row.id, false]))
    for (const row of history.messages) placement.set(row.id, true)
    const tags = new Map([...history.messages, ...history.nativeArchivedMessages].map(row => [row.id, row.nativeHistory]))
    const next: typeof history = { messages: [], nativeArchivedMessages: [] }
    for (const row of rows.values()) {
      if (tags.has(row.id)) row.nativeHistory = tags.get(row.id)
      const destination = (placement.get(row.id) ?? active.has(row.id)) ? next.messages : next.nativeArchivedMessages
      destination.push(row)
    }
    const order = (a: typeof next.messages[number], b: typeof next.messages[number]) =>
      (a.nativeHistory?.order ?? Number.MAX_SAFE_INTEGER) - (b.nativeHistory?.order ?? Number.MAX_SAFE_INTEGER)
    managed.messages = next.messages.sort(order).map(storedToMessage)
    managed.nativeArchivedMessages = next.nativeArchivedMessages.sort(order)
    const { preview, messageCount, lastMessageRole, lastFinalMessageId } = createSessionHeader(this.toStored(managed))
    Object.assign(managed, { preview, messageCount, lastMessageRole, lastFinalMessageId })
  }

  private async prepareNativeFork(sessionId: string, request: PiNativeOwnerRequest): Promise<NativeForkProof> {
    const proof = prepareNativeForkProof(this.nativeForkIdentity(sessionId), request)
    await this.persistNativeForkHistory(sessionId, proof)
    return proof
  }

  private async closeNativeFork(sourceId: string, targetId: string, prepared: NativeForkProof,
    reference: NativeSessionReference): Promise<NativeForkProof> {
    const source = this.sessions.get(sourceId)
    const target = this.sessions.get(targetId)
    if (!source || !target || source.workspace.id !== target.workspace.id
      || source.workspace.rootPath !== target.workspace.rootPath
      || target.nativeSessionOwner?.transactionId !== source.nativeSessionOwner?.transactionId
      || !target.nativeSessionOwner?.unpublished) throw new Error('Native fork target is outside its prepared owner')
    const proof = closeNativeForkProof(prepared, this.nativeForkIdentity(sourceId, reference))
    await this.persistNativeForkHistory(sourceId, proof)
    this.ensureMessagesLoaded(source)
    const history = partitionNativeProductHistory(this.toStored(source), { ...proof.tree, leaf: proof.tree.reference.leaf }, {
      sourceSessionId: sourceId, targetSessionId: targetId, leaf: proof.record.nativeLeafId,
      sourceOnlyMessageIds: new Set(proof.record.inputId ? [proof.record.inputId] : []),
    })
    const targetPath = getSessionStoragePath(target.workspace.rootPath, targetId)
    copyReferencedSessionFiles([...history.messages, ...history.nativeArchivedMessages], proof.sourcePath, targetPath)
    const copied = remapSessionFileReferences(history, proof.sourcePath, targetPath)
    await this.persistNativeMetadata(targetId, (snapshot, managed) => {
      if (managed !== target || snapshot.messages.length || snapshot.nativeArchivedMessages?.length) {
        throw new Error('Native fork target already has product history')
      }
      Object.assign(snapshot, copied)
      snapshot.name = proof.tree.hasName ? proof.tree.reference.name ?? '' : source.name
      snapshot.lastMessageAt = copied.messages.at(-1)?.timestamp
      const { preview, messageCount, lastMessageRole, lastFinalMessageId } = createSessionHeader(snapshot)
      return () => {
        managed.messages = copied.messages.map(storedToMessage)
        managed.nativeArchivedMessages = copied.nativeArchivedMessages
        managed.messagesLoaded = true
        managed.name = snapshot.name
        managed.lastMessageAt = snapshot.lastMessageAt
        Object.assign(managed, { preview, messageCount, lastMessageRole, lastFinalMessageId })
      }
    })
    return proof
  }

  private nativeSessionByPath(sourceId: string, path: string): ManagedSession {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Native session requires a canonical registered path')
    const source = this.sessions.get(sourceId)
    if (!source) throw new Error('Native session source was deleted')
    const candidates = [...this.sessions.values()].filter(session =>
      session.workspace.id === source.workspace.id && session.workspace.rootPath === source.workspace.rootPath
      && session.nativeSessionProjection?.sessionFile === path)
    if (candidates.length !== 1) throw new Error('Native session path is not uniquely registered in this workspace')
    const target = candidates[0]!
    if (this.deletingSessions.has(target.id)) throw new Error('Native session target is being deleted')
    const reference = target.nativeSessionProjection!
    if ((target.sdkSessionId && target.sdkSessionId !== reference.nativeSessionId)
      || [...this.sessions.values()].some(session => session.id !== target.id
        && session.workspace.id === source.workspace.id
        && session.nativeSessionProjection?.nativeSessionId === reference.nativeSessionId)) {
      throw new Error('Native session target identity is not unique')
    }
    return target
  }

  private prepareNativeParent(sourceId: string, request: PiNativeOwnerRequest): NativeSessionReference {
    if (request.operation.type !== 'new' || request.operation.parentSession === undefined) {
      throw new Error('Native parent session path is missing')
    }
    const parent = this.nativeSessionByPath(sourceId, request.operation.parentSession)
    if (parent.nativeSessionOwner?.unpublished || (parent.id !== sourceId && this.nativeOwners.isLocked(parent.id))) {
      throw new Error('Native parent session is unavailable')
    }
    return readTrustedNativeSession(this.nativeForkIdentity(parent.id)).reference
  }

  private prepareNativeSwitch(sourceId: string, request: PiNativeOwnerRequest): NativeSwitchProof {
    if (request.operation.type !== 'switch') throw new Error('Native switch operation is missing')
    const target = this.nativeSessionByPath(sourceId, request.operation.sessionPath)
    if (target.id === sourceId || this.nativeOwners.isLocked(target.id)
      || target.isProcessing || this.adoptedTurns.has(target.id) || target.messageQueue.length
      || target.nativeSessionOwner?.unpublished || target.codingMode !== true) {
      throw new Error('Native switch target is busy or unavailable')
    }
    if (target.agent && !target.agent.nativeSessionOwner?.assertAvailable) {
      throw new Error('Native switch target backend cannot validate availability')
    }
    target.agent?.nativeSessionOwner?.assertAvailable?.()
    return prepareNativeSwitchProof(this.nativeForkIdentity(target.id))
  }

  private async closeNativeSwitch(targetId: string, prepared: NativeSwitchProof): Promise<NativeSwitchProof> {
    const proof = closeNativeSwitchProof(prepared, this.nativeForkIdentity(targetId))
    if (proof.tree.hasName) await this.persistNativeMetadata(targetId, (snapshot, managed) => {
      snapshot.name = proof.tree.reference.name ?? ''
      return () => { managed.name = snapshot.name }
    })
    return proof
  }

  private async rollbackNativeTarget(sessionId: string, transactionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    const record = managed?.nativeSessionOwner
    if (!managed || record?.role !== 'target' || record.transactionId !== transactionId) return
    if (record.operation === 'switch') {
      const source = this.sessions.get(record.sourceSessionId)?.nativeSessionOwner
      const failed = source?.transactionId === transactionId ? source : record
      await this.persistNativeOwner(sessionId, { ...failed, role: 'target',
        phase: failed.phase === 'aborted' ? 'aborted' : 'failed', callbacks: 'interrupted', unpublished: undefined }, transactionId)
      return
    }
    if (!record.unpublished) return
    sessionPersistenceQueue.cancel(sessionId)
    await sessionPersistenceQueue.flush(sessionId)
    this.extensionUI.remove(sessionId)
    unregisterSessionScopedToolCallbacks(sessionId)
    if (!deleteStoredSession(managed.workspace.rootPath, sessionId)) throw new Error('Could not roll back native target session')
    this.sessions.delete(sessionId)
    this.inputClients.retireSession(sessionId)
  }

  private async recoverNativeOwners(): Promise<void> {
    for (const managed of [...this.sessions.values()]) {
      const record = managed.nativeSessionOwner
      if (record?.role !== 'target' || !record.unpublished) continue
      const source = this.sessions.get(record.sourceSessionId)
      const authority = source?.nativeSessionOwner
      if (source?.workspace.id === managed.workspace.id && authority?.role === 'source'
        && authority.transactionId === record.transactionId && authority.targetSessionId === managed.id && authority.committed) {
        await this.persistNativeOwner(managed.id, { ...record, committed: true, unpublished: undefined, callbacks: 'interrupted' })
      } else {
        await this.rollbackNativeTarget(managed.id, record.transactionId)
      }
    }
    for (const managed of this.sessions.values()) {
      const record = managed.nativeSessionOwner
      if (!record || record.callbacks === 'interrupted' || ['finished', 'failed', 'aborted'].includes(record.phase)) continue
      await this.persistNativeOwner(managed.id, { ...record, phase: record.committed ? 'committed' : 'aborted', callbacks: 'interrupted', error: 'Native replacement interrupted by restart; callbacks were not replayed' })
    }
  }

  private handleAgentEvent(managed: ManagedSession, event: AgentEvent): boolean {
    const sessionId = managed.id
    let isTurnError = false
    switch (event.type) {
      case 'text_discard':
        // Failed partial text is never persisted here; tell each client which
        // in-progress renderer/terminal stream must be discarded.
        this.emit(managed.workspace.id, { ...event, sessionId })
        break
      case 'retry':
        // Retry progress is transient and must not enter transcript history.
        this.emit(managed.workspace.id, { ...event, sessionId })
        break
      case 'text_complete': {
        const message: Message = {
          id: event.sdkMessageId ?? generateMessageId(),
          role: 'assistant',
          content: event.text,
          timestamp: this.nextTimestamp(),
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        }
        managed.messages.push(message)
        managed.lastFinalMessageId = message.id
        managed.lastMessageRole = 'assistant'
        managed.hasUnread = this.activeViewingByWorkspace.get(managed.workspace.id) !== sessionId
        this.emit(managed.workspace.id, { type: 'text_complete', sessionId, text: event.text, messageId: message.id, timestamp: message.timestamp, turnId: event.turnId, parentToolUseId: event.parentToolUseId })
        break
      }
      case 'text_delta':
        this.emit(managed.workspace.id, { type: 'text_delta', sessionId, delta: event.text, turnId: event.turnId })
        break
      case 'tool_start':
        managed.pendingToolInputs.set(event.toolUseId, { toolName: event.toolName, input: event.input })
        this.emit(managed.workspace.id, { type: 'tool_start', sessionId, toolName: event.toolName, toolUseId: event.toolUseId, toolInput: event.input, toolIntent: event.intent, toolDisplayName: event.displayName, toolDisplayMeta: event.toolDisplayMeta, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp: this.nextTimestamp() })
        break
      case 'tool_result': {
        const pending = managed.pendingToolInputs.get(event.toolUseId)
        const stored = managed.messages.find(message => message.toolUseId === event.toolUseId)
        const redactedInput = redactBrowserPasswordFills(pending?.toolName ?? stored?.toolName ?? event.toolName ?? '', pending?.input ?? stored?.toolInput, event.result)
        managed.pendingToolInputs.delete(event.toolUseId)
        if (stored && redactedInput) {
          stored.toolInput = redactedInput
          stored.toolResult = event.result
          stored.toolStatus = event.isError ? 'error' : 'completed'
        }
        // Compact transcripts do not persist tool messages; retain a running shell's output
        // path from its launch acknowledgement before the result leaves this process.
        for (const task of managed.backgroundTaskRegistry.values()) {
          if (task.toolUseId !== event.toolUseId) continue
          const outputFile = launchOutputFile(event.result, task.taskId)
          if (outputFile) managed.backgroundTaskOutputs.set(task.taskId, { outputFile })
        }
        this.emit(managed.workspace.id, { type: 'tool_result', sessionId, toolUseId: event.toolUseId, toolName: event.toolName ?? 'tool', result: event.result, ...(redactedInput ? { toolInput: redactedInput } : {}), isError: event.isError, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp: this.nextTimestamp() })
        break
      }
      case 'status':
        managed.currentStatus = { message: event.message }
        this.emit(managed.workspace.id, { type: 'status', sessionId, message: event.message })
        break
      case 'info':
        if (event.compactionTrigger) managed.currentStatus = undefined
        if (event.compactionTrigger === 'manual' && managed.pendingPlanExecution) {
          managed.pendingPlanExecution.awaitingCompaction = false
          this.persistSession(managed)
        }
        this.emit(managed.workspace.id, { type: 'info', sessionId, message: event.message, ...(event.compactionTrigger ? { statusType: 'compaction_complete' as const } : {}) })
        break
      case 'error': {
        if (!managed.isProcessing || event.message.includes('aborted') || event.message.includes('AbortError')) break
        const message: Message = {
          id: generateMessageId(),
          role: 'error',
          content: event.message,
          timestamp: this.nextTimestamp(),
        }
        managed.messages.push(message)
        this.emit(managed.workspace.id, {
          type: 'error',
          sessionId,
          error: event.message,
          backgroundTasksAlive: [...managed.backgroundTaskRegistry.values()].some(task => task.status === 'running'),
          timestamp: message.timestamp,
        })
        isTurnError = true
        break
      }
      case 'typed_error': {
        const errorText = event.error.message || event.error.title || ''
        if (!managed.isProcessing || errorText.includes('aborted') || errorText.includes('AbortError')) break
        const message: Message = {
          id: generateMessageId(),
          role: 'error',
          content: [event.error.title, event.error.message].filter(Boolean).join(': ') || 'An error occurred',
          timestamp: this.nextTimestamp(),
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry: event.error.canRetry,
        }
        managed.messages.push(message)
        this.emit(managed.workspace.id, {
          type: 'typed_error',
          sessionId,
          error: event.error,
          timestamp: message.timestamp,
        })
        isTurnError = true
        break
      }
      case 'working_directory_changed':
        managed.workingDirectory = event.workingDirectory
        this.emit(managed.workspace.id, { type: 'working_directory_changed', sessionId, workingDirectory: event.workingDirectory })
        break
      case 'complete':
        if (event.usage) {
          addTurnUsage(managed.tokenUsage, event.usage)
        }
        this.emit(managed.workspace.id, { type: 'complete', sessionId, tokenUsage: managed.tokenUsage, hasUnread: managed.hasUnread, backgroundTasksAlive: [...managed.backgroundTaskRegistry.values()].some(task => task.status === 'running') })
        break
      case 'context_usage':
        managed.tokenUsage.contextUsage = event.contextUsage
        this.emit(managed.workspace.id, { type: 'usage_update', sessionId, tokenUsage: {
          inputTokens: managed.tokenUsage.inputTokens,
          contextWindow: managed.tokenUsage.contextWindow,
          contextUsage: event.contextUsage,
        } })
        break
      case 'compaction_failed':
        break
      case 'usage_update':
        managed.tokenUsage.inputTokens = event.usage.inputTokens
        if (event.usage.contextWindow) managed.tokenUsage.contextWindow = event.usage.contextWindow
        this.emit(managed.workspace.id, { type: 'usage_update', sessionId, tokenUsage: event.usage })
        break
      case 'task_backgrounded':
        managed.backgroundTaskRegistry.set(event.taskId, {
          taskId: event.taskId,
          toolUseId: event.toolUseId,
          intent: event.intent,
          startTime: Date.now(),
          status: 'running',
          turnId: event.turnId,
          ...(event.workflowId ? { workflowId: event.workflowId } : {}),
          ...(event.kind === 'workflow' ? { agentsCompleted: 0 } : {}),
        })
        this.emit(managed.workspace.id, { ...event, sessionId })
        break
      case 'shell_backgrounded':
        managed.backgroundTaskRegistry.set(event.shellId, { taskId: event.shellId, toolUseId: event.toolUseId, intent: event.intent, startTime: Date.now(), status: 'running', turnId: event.turnId })
        this.emit(managed.workspace.id, { type: 'shell_backgrounded', sessionId, toolUseId: event.toolUseId, shellId: event.shellId, intent: event.intent, command: event.command, turnId: event.turnId })
        break
      case 'task_activity': {
        const task = managed.backgroundTaskRegistry.get(event.taskId)
        if (task) { task.lastProgressAt = Date.now(); this.emit(managed.workspace.id, { ...event, sessionId }) }
        break
      }
      case 'task_progress':
        for (const task of managed.backgroundTaskRegistry.values()) {
          if (task.toolUseId === event.toolUseId) {
            task.elapsedSeconds = event.elapsedSeconds
            task.lastProgressAt = Date.now()
            break
          }
        }
        this.emit(managed.workspace.id, { type: 'task_progress', sessionId, toolUseId: event.toolUseId, elapsedSeconds: event.elapsedSeconds, turnId: event.turnId })
        break
      case 'task_completed': {
        const task = managed.backgroundTaskRegistry.get(event.taskId)
          ?? [...managed.backgroundTaskRegistry.values()].find(item => item.workflowId === event.taskId)
        managed.backgroundTaskOutputs.set(event.taskId, { outputFile: event.outputFile })
        const wasAlreadyTerminal = task ? task.status !== 'running' : false
        if (task) {
          task.status = event.status
          task.completedAt = Date.now()
        } else {
          managed.backgroundTaskRegistry.set(event.taskId, {
            taskId: event.taskId,
            startTime: Date.now(),
            status: event.status,
            completedAt: Date.now(),
          })
        }
        this.emit(managed.workspace.id, { type: 'task_completed', sessionId, taskId: event.taskId, status: event.status, outputFile: event.outputFile, summary: event.summary, turnId: event.turnId })
        if (!managed.isProcessing && !wasAlreadyTerminal && !(event.status === 'stopped' && task?.stopRequestedAt)) {
          const label = task?.intent ? `"${task.intent}"` : `task ${event.taskId}`
          const nudge = event.status === 'completed'
            ? [
                `[background-task-completed] The background agent you launched (${label}) has finished.`,
                event.outputFile ? `Its full output is saved at: ${event.outputFile}` : '',
                'Read that output file and present the results to the user now. Do NOT spawn another background agent — just read the file and summarize the findings inline.',
              ].filter(Boolean).join('\n')
            : `[background-task-${event.status}] The background agent you launched (${label}) did not complete successfully. Do NOT spawn another background agent.`
          void this.sendMessage(sessionId, labelSystemNotice(nudge), undefined, undefined, { hidden: true })
            .catch(error => log.error('Failed to surface background task result', event.taskId, error))
        }
        break
      }
      case 'shell_killed':
        this.emit(managed.workspace.id, { type: 'shell_killed', sessionId, shellId: event.shellId })
        break
      case 'permission_request':
        this.emit(managed.workspace.id, { type: 'permission_request', sessionId, request: { sessionId, requestId: event.requestId, toolName: event.toolName, command: event.command, description: event.description, type: event.permissionType, appName: event.appName, reason: event.reason, impact: event.impact, requiresSystemPrompt: event.requiresSystemPrompt, canAlwaysAllow: event.canAlwaysAllow, rememberForMinutes: event.rememberForMinutes, commandHash: event.commandHash, approvalTtlSeconds: event.approvalTtlSeconds } })
        break
      case 'pi_turn_anchor':
        void savePiTurnAnchor(
          getSessionStoragePath(managed.workspace.rootPath, sessionId),
          event.sdkMessageId,
          event.sdkTurnAnchor,
        ).catch(error => log.warn('Failed to persist Pi turn anchor', sessionId, error))
        break
      case 'workflow_agent_completed':
        for (const task of managed.backgroundTaskRegistry.values()) {
          if (task.workflowId === event.workflowId) {
            task.agentsCompleted = (task.agentsCompleted ?? 0) + 1
            break
          }
        }
        this.emit(managed.workspace.id, { ...event, sessionId })
        break
      case 'steer_undelivered':
        break
    }
    this.persistSession(managed)
    return isTurnError
  }

  /** Craft-compatible async entry point for events arriving outside a live turn. */
  private async processEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    const adopted = this.adoptedTurns.get(managed.id)
    if (event.type === 'complete' && adopted) {
      if (adopted.completed) return
      adopted.completed = true
    }
    if (this.handleAgentEvent(managed, event) && adopted) adopted.error = true
    await this.flushSession(managed.id)
  }

  /** Craft browser-tool bridge, scoped to the current local session. */
  private createBrowserPaneFns(managed: ManagedSession): BrowserPaneFns | undefined {
    const browser = this.browserPaneManager
    if (!browser) return undefined
    const workspaceId = managed.workspace.id
    const getInstanceId = async () => {
      const id = await browser.getOrCreateForSessionAsync(managed.id, { workspaceId })
      // Agent control also enables rendering while hidden, required for CDP input.
      browser.setAgentControl(managed.id, {}, { workspaceId })
      return id
    }
    const lifecycleTarget = async (requested?: string) => requested ?? await browser.getOrCreateForSessionAsync(managed.id, { workspaceId })

    return {
      openPanel: async options => ({
        instanceId: options?.background
          ? await browser.createForSessionAsync(managed.id, { show: false, workspaceId })
          : await browser.focusBoundForSessionAsync(managed.id, { workspaceId }),
      }),
      navigate: async url => browser.navigate(await getInstanceId(), url),
      snapshot: async () => browser.getAccessibilitySnapshot(await getInstanceId()),
      click: async (ref, options) => browser.clickElement(await getInstanceId(), ref, options),
      clickAt: async (x, y) => browser.clickAtCoordinates(await getInstanceId(), x, y),
      drag: async (x1, y1, x2, y2) => browser.drag(await getInstanceId(), x1, y1, x2, y2),
      fill: async (ref, value) => browser.fillElement(await getInstanceId(), ref, value),
      type: async text => browser.typeText(await getInstanceId(), text),
      select: async (ref, value) => browser.selectOption(await getInstanceId(), ref, value),
      setClipboard: async text => browser.setClipboard(await getInstanceId(), text),
      getClipboard: async () => browser.getClipboard(await getInstanceId()),
      screenshot: async args => browser.screenshot(await getInstanceId(), args),
      screenshotRegion: async args => browser.screenshotRegion(await getInstanceId(), args),
      getConsoleLogs: async args => browser.getConsoleLogs(await getInstanceId(), args),
      windowResize: async args => browser.windowResize(await getInstanceId(), args.width, args.height),
      getNetworkLogs: async args => browser.getNetworkLogs(await getInstanceId(), args),
      waitFor: async args => browser.waitFor(await getInstanceId(), args),
      sendKey: async args => browser.sendKey(await getInstanceId(), args),
      getDownloads: async args => browser.getDownloads(await getInstanceId(), args),
      upload: async (ref, paths) => { await browser.uploadFile(await getInstanceId(), ref, paths) },
      scroll: async (direction, amount) => browser.scroll(await getInstanceId(), direction, amount),
      goBack: async () => browser.goBack(await getInstanceId()),
      goForward: async () => browser.goForward(await getInstanceId()),
      evaluate: async expression => browser.evaluate(await getInstanceId(), expression),
      focusWindow: async requested => {
        const instanceId = await lifecycleTarget(requested)
        browser.focus(instanceId)
        const info = await browser.getInstanceAsync(instanceId)
        return { instanceId, title: info?.title ?? '', url: info?.currentUrl ?? '' }
      },
      releaseControl: async requested => {
        const instanceId = await lifecycleTarget(requested)
        const result = browser.clearAgentControlForInstance(instanceId, managed.id)
        return {
          action: result.released ? 'released' : 'noop',
          requestedInstanceId: requested,
          resolvedInstanceId: instanceId,
          affectedIds: result.released ? [instanceId] : [],
          reason: result.reason,
        }
      },
      closeWindow: async requested => {
        const instanceId = await lifecycleTarget(requested)
        browser.destroyInstance(instanceId)
        return { action: 'closed', requestedInstanceId: requested, resolvedInstanceId: instanceId, affectedIds: [instanceId] }
      },
      hideWindow: async requested => {
        const instanceId = await lifecycleTarget(requested)
        browser.hide(instanceId)
        return { action: 'hidden', requestedInstanceId: requested, resolvedInstanceId: instanceId, affectedIds: [instanceId] }
      },
      listWindows: async () => browser.listInstancesAsync(),
      detectChallenge: async () => browser.detectSecurityChallenge(await getInstanceId()),
    }
  }

  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentBackend> {
    if (managed.agent) {
      await this.refreshManagedRuntime(managed)
      if (managed.agent) return managed.agent
    }
    if (!platform) throw new Error('Session platform has not been initialized')
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const context = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })
    const agent = createBackendFromResolvedContext({
      context,
      hostRuntime: {
        appRootPath: platform.appRootPath,
        resourcesPath: platform.resourcesPath,
        isPackaged: platform.isPackaged,
      },
      coreConfig: {
        workspace: managed.workspace,
        extensionUI: this.extensionUI.port(managed.id),
        nativeSessionOwner: this.nativeOwners.port(managed.id, !!managed.nativeSessionOwner?.unpublished),
        session: this.toStored(managed),
        model: context.resolvedModel,
        autoCompactWindow: getAutoCompactWindow(),
        agentProfile: managed.codingMode ? 'coding' : undefined,
        getTransferredSessionSummary: () => managed.transferredSessionSummaryApplied ? null : managed.transferredSessionSummary ?? null,
        markTransferredSessionSummaryApplied: () => {
          managed.transferredSessionSummaryApplied = true
          this.persistSession(managed)
        },
        miniModel: context.connection ? getMiniModel(context.connection) : undefined,
        thinkingLevel: managed.thinkingLevel,
        isHeadless: !this.browserPaneManager,
        skipConfigWatcher: true,
        onSdkSessionIdUpdate: sdkSessionId => {
          managed.sdkSessionId = sdkSessionId
          this.persistSession(managed)
        },
        getRecoveryMessages: () => managed.messages.slice(-12).map(item => ({ type: item.role === 'assistant' ? 'assistant' : 'user', content: item.content })),
      },
    })
    // Restore the persisted mode before wiring callbacks or starting the Pi runtime.
    // A continued session must use the same mode that the UI and stored header show.
    agent.setPermissionMode(managed.permissionMode ?? 'ask')
    agent.onPermissionRequest = request => {
      this.handleAgentEvent(managed, { ...request, type: 'permission_request', permissionType: request.type })
    }
    agent.onPlanSubmitted = planPath => {
      const message: Message = { id: generateMessageId(), role: 'plan', content: planPath, timestamp: this.nextTimestamp() }
      managed.messages.push(message)
      this.emit(managed.workspace.id, { type: 'plan_submitted', sessionId: managed.id, message })
    }
    agent.onPermissionModeChange = mode => {
      managed.previousPermissionMode = managed.permissionMode
      managed.permissionMode = mode
      this.emit(managed.workspace.id, { type: 'permission_mode_changed', sessionId: managed.id, permissionMode: mode, previousPermissionMode: managed.previousPermissionMode, changedBy: 'system', changedAt: new Date().toISOString() })
    }
    // Craft's session self-management wiring, reduced to the Lite session surface.
    agent.onSpawnSession = async request => {
      const session = await this.createSession(managed.workspace.id, {
        name: request.name,
        llmConnection: request.llmConnection ?? managed.llmConnection,
        model: request.model ?? managed.model,
        permissionMode: clampSpawnPermissionMode(request.permissionMode, managed.permissionMode),
        thinkingLevel: request.thinkingLevel ?? managed.thinkingLevel,
        workingDirectory: request.workingDirectory,
        parentSessionId: managed.id,
      })
      let fileAttachments: FileAttachment[] | undefined
      if (request.attachments?.length) {
        const attachments: FileAttachment[] = []
        for (const item of request.attachments) {
          try {
            const allowedDirs = getWorkspaceAllowedDirs(managed.workspace.id)
            if (request.workingDirectory) allowedDirs.push(request.workingDirectory)
            const attachment = readFileAttachment(await validateFilePath(item.path, allowedDirs))
            if (attachment) {
              if (item.name) attachment.name = item.name
              attachments.push(attachment)
            }
          } catch (error) {
            log.warn('Spawn session attachment rejected', item.path, error)
          }
        }
        if (attachments.length) fileAttachments = attachments
      }
      void this.sendMessage(session.id, request.prompt, fileAttachments)
        .catch(error => log.error('Failed to start spawned session', session.id, error))
      return {
        sessionId: session.id,
        name: session.name ?? request.name ?? session.id,
        status: 'started',
        connection: session.llmConnection,
        model: session.model,
      }
    }
    const browserPaneFns = this.createBrowserPaneFns(managed)
    mergeSessionScopedToolCallbacks(managed.id, {
      ...(browserPaneFns ? { browserPaneFns } : {}),
      prWatch: managed.codingMode ? buildPrWatchToolCallbacks({ sessionId: managed.id, sessionManager: this, getRegistry: getPrWatchRegistry, getAutoFixMonitor: getPrAutoFixMonitor }) : undefined,
      archiveSessionFn: async (sessionId, archived) => {
        const target = this.sessions.get(sessionId)
        const guardError = validateArchiveTarget(
          target ? { workspaceId: target.workspace.id, isProcessing: target.isProcessing } : undefined,
          managed.workspace.id,
          sessionId,
          archived,
        )
        if (guardError) throw new Error(guardError)
        if (archived) await this.archiveSession(sessionId)
        else await this.unarchiveSession(sessionId)
      },
      getSessionInfoFn: (sessionId = managed.id) => {
        const session = this.sessions.get(sessionId)
        if (!session) return null
        return {
          id: session.id,
          name: session.name ?? session.id,
          permissionMode: session.permissionMode ?? 'ask',
          createdAt: session.createdAt,
          updatedAt: session.lastUsedAt,
          workingDirectory: session.workingDirectory,
          llmConnection: session.llmConnection,
          model: session.model,
          isActive: session.agent != null,
          isArchived: session.isArchived,
          isFlagged: session.isFlagged,
          hasUnread: session.hasUnread,
        }
      },
      listSessionsFn: options => {
        const limit = Math.min(options?.limit ?? 20, 100)
        const offset = options?.offset ?? 0
        let sessions = this.getSessions(managed.workspace.id)
        if (options?.archived !== undefined) {
          sessions = sessions.filter(item => Boolean(item.isArchived) === options.archived)
        }
        if (options?.search) {
          const query = options.search.toLowerCase()
          sessions = sessions.filter(item => item.name?.toLowerCase().includes(query))
        }
        sessions.sort(options?.sortBy === 'name'
          ? (a, b) => (a.name ?? '').localeCompare(b.name ?? '')
          : (a, b) => b.lastMessageAt - a.lastMessageAt)
        const page = sessions.slice(offset, offset + limit)
        return {
          total: sessions.length,
          returned: page.length,
          sessions: page.map(item => ({
            id: item.id,
            name: item.name ?? item.id,
            createdAt: item.createdAt ?? 0,
            lastUsedAt: item.lastMessageAt,
            isArchived: item.isArchived,
            isFlagged: item.isFlagged,
            hasUnread: item.hasUnread,
            isProcessing: item.isProcessing,
          })),
        }
      },
      listBackgroundTasksFn: (sessionId = managed.id) => this.listBackgroundTasks(sessionId),
      sendAgentMessageFn: async (sessionId, message, attachments) => {
        let fileAttachments: FileAttachment[] | undefined
        if (attachments?.length) {
          const resolved: FileAttachment[] = []
          for (const item of attachments) {
            const attachment = readFileAttachment(
              await validateFilePath(item.path, getWorkspaceAllowedDirs(managed.workspace.id)),
            )
            if (attachment) {
              if (item.name) attachment.name = item.name
              resolved.push(attachment)
            }
          }
          if (resolved.length) fileAttachments = resolved
        }
        const targetBusy = this.sessions.get(sessionId)?.isProcessing === true
        await this.sendMessage(sessionId, message, fileAttachments)
        return { delivery: targetBusy ? 'queued' : 'delivered', targetBusy }
      },
    })
    this.bindBackgroundEvents(managed, agent)
    const result = await agent.postInit()
    if (result.authWarning) log.warn(result.authWarning)
    managed.agent = agent
    managed.backendRuntimeSignature = buildBackendRuntimeSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel, autoCompactWindow: getAutoCompactWindow() })
    managed.backendRestartSignature = buildRestartRequiredSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel, autoCompactWindow: getAutoCompactWindow() })
    return agent
  }

  private bindBackgroundEvents(managed: ManagedSession, agent: AgentBackend): void {
    agent.setBackgroundEventSink?.(event => {
      if (this.sessions.get(managed.id) !== managed) return
      const adopted = this.adoptedTurns.get(managed.id)
      const processing = this.processEvent(managed, event)
      if (adopted) {
        adopted.events = Promise.all([adopted.events, processing]).then(() => {})
        void adopted.events.catch(() => {})
      }
      void processing.catch(error => log.warn('Failed to process background event', managed.id, error))
    })
  }

  async refreshConnectionRuntime(connectionSlug: string): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter(managed => managed.llmConnection === connectionSlug && managed.agent)
      .map(managed => this.refreshManagedRuntime(managed)))
  }

  private async refreshManagedRuntime(managed: ManagedSession): Promise<void> {
    const pending = managed.runtimeRefreshPromise
    const refresh = (pending?.catch(() => {}) ?? Promise.resolve()).then(() => this.performRuntimeRefresh(managed))
    managed.runtimeRefreshPromise = refresh
    try {
      await refresh
    } finally {
      if (managed.runtimeRefreshPromise === refresh) managed.runtimeRefreshPromise = undefined
    }
  }

  private async performRuntimeRefresh(managed: ManagedSession): Promise<void> {
    const agent = managed.agent
    if (!agent || this.nativeOwners.isLocked(managed.id) || agent.isProcessing()) return
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const context = resolveBackendContext({ sessionConnectionSlug: managed.llmConnection, workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection, managedModel: managed.model })
    const runtimeSignature = buildBackendRuntimeSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel, autoCompactWindow: getAutoCompactWindow() })
    if (runtimeSignature === managed.backendRuntimeSignature) return
    const restartSignature = buildRestartRequiredSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel, autoCompactWindow: getAutoCompactWindow() })
    if (restartSignature !== managed.backendRestartSignature || !agent.updateRuntimeConfig) {
      await agent.disposeForRestart?.()
      agent.dispose()
      managed.agent = null
      return
    }
    const connection = context.connection
    const updated = await agent.updateRuntimeConfig({
      model: context.resolvedModel,
      providerType: connection?.providerType,
      authType: context.authType,
      runtime: connection ? {
        baseUrl: connection.baseUrl,
        piAuthProvider: connection.piAuthProvider,
        customEndpoint: connection.customEndpoint,
        customModels: connection.models?.map(model => typeof model === 'string' ? model : ({ id: model.id, contextWindow: model.contextWindow, supportsImages: model.supportsImages })),
      } : {},
    })
    if (!updated || managed.agent !== agent) return
    managed.backendRuntimeSignature = runtimeSignature
    managed.backendRestartSignature = restartSignature
  }

  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.isProcessing || this.deletingSessions.has(sessionId) || this.nativeOwners.isLocked(sessionId) || this.isSessionUnpublished(sessionId)) return
    const queued = managed.messageQueue.shift()
    if (!queued) return
    const existing = managed.messages.find(item => item.id === queued.messageId)
    if (existing) {
      existing.isQueued = false
      existing.timestamp = this.nextTimestamp()
      this.emit(managed.workspace.id, { type: 'user_message', sessionId, message: existing, status: 'processing', optimisticMessageId: queued.optimisticMessageId })
    }
    this.persistSession(managed)
    void this.sendMessage(sessionId, queued.message, queued.attachments, queued.storedAttachments, queued.options, queued.messageId, true)
  }

  private nextTimestamp(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1)
    return this.lastTimestamp
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    this.inputClients.cancelTurn(sessionId, new Set(managed.messageQueue.map(input => input.messageId)))
    const ownerForeground = this.nativeOwners.isLocked(sessionId)
    const ownerCancellation = this.nativeOwners.cancel(sessionId)
    if (!managed.isProcessing) { await ownerCancellation; return }
    managed.stopEpoch = (managed.stopEpoch ?? 0) + 1
    managed.cancelHandoffWait?.()
    if (!ownerForeground && managed.agent && !managed.agent.stopTurn?.()) managed.agent.forceAbort(AbortReason.UserStop)
    managed.isProcessing = false
    if (!silent) this.emit(managed.workspace.id, { type: 'interrupted', sessionId, backgroundTasksAlive: [...managed.backgroundTaskRegistry.values()].some(task => task.status === 'running') })
    await ownerCancellation
  }

  async killShell(sessionId: string, shellId: string): Promise<StopBackgroundTaskResult> {
    return this.stopBackgroundTask(sessionId, shellId)
  }

  async stopBackgroundTask(sessionId: string, taskId: string): Promise<StopBackgroundTaskResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return { success: false, error: 'Session not found' }
    const entry = managed.backgroundTaskRegistry.get(taskId)
    // Nothing alive to stop: record it, so status queries agree with the chip
    const notRunning = (): StopBackgroundTaskResult => {
      if (entry?.status === 'running') {
        entry.status = 'stopped'
        entry.completedAt = Date.now()
      }
      return { success: false, error: 'not-running' }
    }
    if (entry && entry.status !== 'running') return { success: false, error: 'not-running' }
    const stop = managed.agent?.stopBackgroundTask
    if (!stop) return notRunning()
    if (entry) entry.stopRequestedAt = Date.now()
    try {
      const stopped = await stop.call(managed.agent, taskId)
      log.info(`[bg-lifecycle] stop requested`, { sessionId, taskId, delivered: stopped })
      return stopped ? { success: true } : notRunning()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The CLI no longer knows the task (it finished, or died with an earlier subprocess), or the
      // query is gone: the task is not running — not a failure to report.
      if (/no task found|is not running|query closed|not running/i.test(message)) return notRunning()
      if (entry) entry.stopRequestedAt = undefined
      log.warn(`[bg-lifecycle] stop failed for task ${taskId}:`, error)
      return { success: false, error: 'failed' }
    }
  }

  /** Wait for a continued session's handoff summary, at most `handoffSummaryWaitMs`. */
  private async waitForHandoffSummary(managed: ManagedSession): Promise<void> {
    const pending = managed.pendingHandoffSummary
    if (!pending) return
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = await Promise.race([
      pending.then(() => true, () => true),
      new Promise<boolean>(resolve => { managed.cancelHandoffWait = () => resolve(false) }),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.handoffSummaryWaitMs) }),
    ])
    clearTimeout(timer)
    managed.cancelHandoffWait = undefined
    if (!ready) managed.handoffSummaryExpired = true
    log.info(`Session ${managed.id}: first turn waited ${Date.now() - startedAt} ms for the previous session's summary${ready ? '' : ', starting without it'}`)
  }

  /**
   * Summarize `source`'s conversation and give it to `target` as one-shot hidden context for its
   * first turn (`transferredSessionSummary`). Never throws: without a summary the new session just
   * starts without the earlier context.
   */
  private async attachHandoffSummary(source: ManagedSession, target: ManagedSession): Promise<void> {
    const startedAt = Date.now()
    try {
      const summary = await this.generateSessionHandoffSummary(source)
      // Deleted while the summary was generated
      if (this.sessions.get(target.id) !== target || target.handoffSummaryExpired) return
      if (summary) {
        target.transferredSessionSummary = summary
        target.transferredSessionSummaryApplied = false
        this.persistSession(target)
        await sessionPersistenceQueue.flush(target.id)
      }
      log.info(`Session ${target.id}: summary of ${source.id} ${summary ? `ready (${summary.length} chars)` : 'empty'} after ${Date.now() - startedAt} ms`)
    } catch (error) {
      log.warn(`Session ${target.id}: summary of ${source.id} failed after ${Date.now() - startedAt} ms:`, error)
    }
  }

  /** Coding mode: PRs pinned to a session (chat-header PR carousel), in addedAt order. */
  getSessionBoundPrs(sessionId: string): BoundPr[] {
    return this.sessions.get(sessionId)?.boundPrs ?? []
  }

  /**
   * Pin a PR to a session (pr_bind). Deduped by host/owner/repo#number — re-binding an existing PR
   * refreshes its position — then persisted. Returns the new list (addedAt order).
   */
  bindPrToSession(sessionId: string, pr: BoundPr): BoundPr[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const next = [...(managed.boundPrs ?? []).filter(p => !sameBoundPr(p, pr)), pr].sort((a, b) => a.addedAt - b.addedAt)
    managed.boundPrs = next
    log.info(`Session ${sessionId}: bound PR ${pr.owner}/${pr.repo}#${pr.number} (${next.length} total)`)
    this.persistSession(managed)
    return next
  }

  /** Remove a pinned PR from a session (pr_unbind); persists and returns the new list. */
  unbindPrFromSession(sessionId: string, pr: { host: string; owner: string; repo: string; number: number }): BoundPr[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const next = (managed.boundPrs ?? []).filter(p => !sameBoundPr(p, pr))
    // Stored only when non-empty, so sessions that never bind keep an unchanged header (like codingMode)
    managed.boundPrs = next.length ? next : undefined
    // An unbound PR's auto-fix goes with it
    const monitorId = prEntryId(pr)
    if (managed.prMonitors?.[monitorId]) {
      const { [monitorId]: _dropped, ...rest } = managed.prMonitors
      managed.prMonitors = Object.keys(rest).length ? rest : undefined
    }
    log.info(`Session ${sessionId}: unbound PR ${pr.owner}/${pr.repo}#${pr.number} (${next.length} left)`)
    this.persistSession(managed)
    return next
  }

  /** Coding mode: per-PR monitor state (auto-fix), keyed by PR id. */
  getSessionPrMonitors(sessionId: string): Record<string, PrMonitorState> {
    return this.sessions.get(sessionId)?.prMonitors ?? {}
  }

  /**
   * Turn auto-fix (the PR card's Fix toggle) on or off for one PR of a session; persists and returns
   * the monitors. Turning it off keeps what the last run acted on, so turning it back on only fixes
   * feedback that is new since then.
   */
  setSessionPrAutoFix(sessionId: string, prId: string, enabled: boolean): Record<string, PrMonitorState> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const monitors = { ...(managed.prMonitors ?? {}) }
    const entry: PrMonitorState = { ...(monitors[prId] ?? {}), autoFix: enabled || undefined }
    if (entry.autoFix || entry.lastFixAt) monitors[prId] = entry
    else delete monitors[prId]
    managed.prMonitors = Object.keys(monitors).length ? monitors : undefined
    log.info(`Session ${sessionId}: auto-fix ${enabled ? 'on' : 'off'} for ${prId}`)
    this.persistSession(managed)
    return managed.prMonitors ?? {}
  }

  /** Record an auto-fix run: when, and the review feedback (signature) it acted on. */
  recordPrAutoFixRun(sessionId: string, prId: string, signature: string[], at: number): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.prMonitors = { ...(managed.prMonitors ?? {}), [prId]: { ...(managed.prMonitors?.[prId] ?? {}), lastFixAt: at, lastFixSignature: signature } }
    this.persistSession(managed)
  }

  /** A session's metadata without loading its messages (cheap, unlike getSession). */
  getSessionSnapshot(sessionId: string): Session | null {
    const managed = this.sessions.get(sessionId)
    return managed ? this.toSession(managed, false) : null
  }

  /**
   * Start a turn in an idle session with an app-generated notice: hidden (never a transcript bubble)
   * and labelled as sent by Craft Agents, not the user — the same path background-task completions
   * use. Returns false, sending nothing, when the session is missing or busy, so the caller can retry.
   */
  wakeIdleSessionWithNotice(sessionId: string, text: string): boolean {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.isProcessing) return false
    void this.sendMessage(sessionId, labelSystemNotice(text), [], [], { hidden: true }).catch((err) => {
      log.error(`Session ${sessionId}: failed to start a system-notice turn:`, err)
    })
    return true
  }

  /**
   * What a background task of the session has written so far, digested for the chip's card: a
   * shell's output tail, or an agent's latest message and recent steps. The file is the one the SDK
   * reported on completion, else the `<taskId>.output` named in the launching tool call's result
   * (see launchOutputFile). Null when there is nothing to read yet.
   */
  async getBackgroundTaskOutput(sessionId: string, taskId: string, kind?: 'agent' | 'shell' | 'workflow'): Promise<BackgroundTaskOutput | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    const path = this.backgroundTaskOutputFile(managed, taskId)
    if (!path) return null
    try {
      return await readBackgroundTaskOutput(path, kind)
    } catch (error) {
      log.debug(`[bg-lifecycle] no readable output for task ${taskId} (${path}):`, error)
      return null
    }
  }

  private backgroundTaskOutputFile(managed: ManagedSession, taskId: string): string | undefined {
    const reported = managed.backgroundTaskOutputs.get(taskId)?.outputFile
    if (reported) return reported
    const toolUseId = managed.backgroundTaskRegistry.get(taskId)?.toolUseId
    if (!toolUseId) return undefined
    const launch = managed.messages.find(message => message.toolUseId === toolUseId && message.toolResult)
    return launch?.toolResult ? launchOutputFile(launch.toolResult, taskId) : undefined
  }


  listBackgroundTasks(sessionId: string) {
    const managed = this.sessions.get(sessionId)
    if (!managed) return []
    const now = Date.now()
    return [...managed.backgroundTaskRegistry.values()].map(task => {
      const end = task.status === 'running' ? now : (task.completedAt ?? now)
      return {
        taskId: task.taskId,
        intent: task.intent,
        status: task.status,
        startTime: task.startTime,
        elapsedSeconds: task.elapsedSeconds ?? Math.max(0, Math.round((end - task.startTime) / 1000)),
        completedAt: task.completedAt,
        workflowId: task.workflowId,
        agentsCompleted: task.agentsCompleted,
      }
    })
  }

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    _options?: PermissionResponseOptions,
  ): boolean {
    const agent = this.sessions.get(sessionId)?.agent
    if (!agent) return false
    agent.respondToPermission(requestId, allowed, alwaysAllow)
    return true
  }

  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.previousPermissionMode = managed.permissionMode
    managed.permissionMode = mode
    managed.agent?.setPermissionMode(mode)
    this.persistSession(managed)
    this.emit(managed.workspace.id, { type: 'permission_mode_changed', sessionId, permissionMode: mode, previousPermissionMode: managed.previousPermissionMode, changedBy: 'user', changedAt: new Date().toISOString() })
  }

  getSessionPermissionModeState(sessionId: string): PermissionModeState | null {
    const managed = this.sessions.get(sessionId)
    if (!managed?.permissionMode) return null
    return { permissionMode: managed.permissionMode, previousPermissionMode: managed.previousPermissionMode, modeVersion: 1, changedAt: new Date().toISOString(), changedBy: 'unknown' }
  }

  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.thinkingLevel = level
    managed.agent?.setThinkingLevel(level)
    this.persistSession(managed)
  }

  setSessionCodingMode(sessionId: string, enabled: boolean): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || !!managed.codingMode === enabled) return
    if (managed.isProcessing || hasConversationStarted(managed)) {
      throw new Error('Coding mode is fixed once a session has messages. Continue in a new session to switch it.')
    }
    managed.codingMode = enabled || undefined
    managed.agent?.setAgentProfile(enabled ? 'coding' : 'default')
    this.persistSession(managed)
    this.emit(managed.workspace.id, { type: 'coding_mode_changed', sessionId, codingMode: enabled })
  }

  private async generateSessionHandoffSummary(managed: ManagedSession): Promise<string | null> {
    this.ensureMessagesLoaded(managed)
    const messages = managed.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && !m.isIntermediate)
      .map(m => ({ type: m.role as 'user' | 'assistant', content: m.content }))
    let summary: string | null = null
    if (messages.length) {
      if (!platform) throw new Error('Session platform has not been initialized')
      const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
      const context = resolveBackendContext({ sessionConnectionSlug: managed.llmConnection, workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection, managedModel: managed.model })
      const agent = createBackendFromResolvedContext({
        context,
        hostRuntime: { appRootPath: platform.appRootPath, resourcesPath: platform.resourcesPath, isPackaged: platform.isPackaged },
        coreConfig: { workspace: managed.workspace, miniModel: context.connection ? getMiniModel(context.connection) : undefined, isHeadless: true, skipConfigWatcher: true },
      })
      try { summary = await generateConversationSummary(messages, agent.runMiniCompletion.bind(agent)) }
      finally { agent.destroy() }
    }
    return summary
  }

  async continueSessionInNewSession(sessionId: string, codingMode: boolean): Promise<{ sessionId: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    if (managed.isProcessing) throw new Error('Wait for the current turn to finish before continuing in a new session.')
    const session = await this.createSession(managed.workspace.id, {
      permissionMode: managed.permissionMode, thinkingLevel: managed.thinkingLevel,
      workingDirectory: managed.workingDirectory ?? 'none', model: managed.model,
      llmConnection: managed.llmConnection, codingMode,
    }, { emitCreatedEvent: false })
    const created = this.sessions.get(session.id)!
    const pending = this.attachHandoffSummary(managed, created).finally(() => {
      if (created.pendingHandoffSummary === pending) created.pendingHandoffSummary = undefined
    })
    created.pendingHandoffSummary = pending
    this.notifySessionCreated(managed.workspace.id, created.id)
    return { sessionId: created.id }
  }

  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.workingDirectory = path
    managed.agent?.updateWorkingDirectory(path)
    this.persistSession(managed)
    this.emit(managed.workspace.id, { type: 'working_directory_changed', sessionId, workingDirectory: path })
  }

  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    if (managed.connectionLocked) throw new Error('Connection cannot be changed after the first message')
    managed.llmConnection = connectionSlug
    await this.flushSession(sessionId)
    this.emit(managed.workspace.id, { type: 'connection_changed', sessionId, connectionSlug })
  }

  async updateSessionModel(sessionId: string, _workspaceId: string, model: string | null, connection?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.model = model ?? undefined
    if (connection) managed.llmConnection = connection
    if (model && managed.agent) managed.agent.setModel(model)
    await this.flushSession(sessionId)
    this.emit(managed.workspace.id, { type: 'session_model_changed', sessionId, model })
  }

  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) this.activeViewingByWorkspace.set(workspaceId, sessionId)
    else this.activeViewingByWorkspace.delete(workspaceId)
  }

  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingByWorkspace.delete(workspaceId)
  }

  markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    return this.updateMetadata(sessionId, { hasUnread: false, lastReadMessageId: managed?.messages.at(-1)?.id })
  }

  markSessionUnread(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { hasUnread: true })
  }

  async markAllSessionsRead(workspaceId: string): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter(managed => managed.workspace.id === workspaceId)
      .map(managed => this.markSessionRead(managed.id)))
    this.refreshBadge()
  }

  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    for (const managed of this.sessions.values()) {
      if (managed.hasUnread) byWorkspace[managed.workspace.id] = (byWorkspace[managed.workspace.id] ?? 0) + 1
    }
    return {
      totalUnreadSessions: Object.values(byWorkspace).reduce((sum, count) => sum + count, 0),
      byWorkspace,
      hasUnreadByWorkspace: Object.fromEntries(Object.entries(byWorkspace).map(([id, count]) => [id, count > 0])),
    }
  }

  refreshBadge(): void {
    runtimeHooks.updateBadgeCount(this.getUnreadSummary().totalUnreadSessions)
  }

  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      log.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(item => item.id === messageId)
    if (!message) {
      log.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      log.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`)
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      log.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`)
      return
    }

    const safeAnnotation: AnnotationV1 = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8')
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      log.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`)
      return
    }

    const existing = message.annotations ?? []
    if (existing.some(item => item.id === safeAnnotation.id)) {
      log.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`)
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      log.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`)
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      log.warn(`Cannot remove annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(item => item.id === messageId)
    if (!message) {
      log.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some(item => item.id === annotationId)) {
      log.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    message.annotations = existing.filter(item => item.id !== annotationId)
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  updateMessageAnnotation(sessionId: string, messageId: string, annotationId: string, patch: Partial<AnnotationV1>): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      log.warn(`Cannot update annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(item => item.id === messageId)
    if (!message) {
      log.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    const index = existing.findIndex(item => item.id === annotationId)
    if (index === -1) {
      log.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
      log.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`)
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      log.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const current = existing[index]!
    const updated: AnnotationV1 = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      log.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const next = [...existing]
    next[index] = updated
    message.annotations = next
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return Promise.resolve()
    managed.pendingPlanExecution = { planPath, draftInputSnapshot, awaitingCompaction: true, executionDispatched: false }
    return setStoredPendingPlanExecution(managed.workspace.rootPath, sessionId, planPath, draftInputSnapshot)
  }

  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    // Only the backend's manual-compaction success event makes a plan ready.
    // Retain this RPC for compatibility, without letting a client bypass that event.
    if (!managed?.pendingPlanExecution || managed.pendingPlanExecution.awaitingCompaction) return
    await markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
  }

  async markPendingPlanExecutionDispatched(sessionId: string): Promise<boolean> {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.isProcessing || !managed.pendingPlanExecution || managed.pendingPlanExecution.awaitingCompaction || managed.pendingPlanExecution.executionDispatched) return false
    managed.pendingPlanExecution.executionDispatched = true
    await this.flushSession(sessionId)
    return true
  }

  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.pendingPlanExecution = undefined
    await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
  }

  getPendingPlanExecution(sessionId: string) {
    const managed = this.sessions.get(sessionId)
    return managed ? getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId) : null
  }

  async acceptPlan(sessionId: string, _planPath?: string): Promise<void> {
    await this.sendMessage(sessionId, 'I approve this plan. Please execute it.')
  }

  getSessionFinalText(sessionId: string): string | undefined {
    return [...(this.sessions.get(sessionId)?.messages ?? [])].reverse().find(item => item.role === 'assistant')?.content
  }

  onSessionComplete(listener: (event: SessionCompletionEvent) => void): () => void {
    this.completionListeners.add(listener)
    return () => this.completionListeners.delete(listener)
  }

  async refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return { success: false, error: 'Session not found' }
    try {
      const agent = await this.getOrCreateAgent(managed)
      const recentUsers = managed.messages.filter(item => item.role === 'user').slice(-3).map(item => item.content)
      const lastAssistant = this.getSessionFinalText(sessionId) ?? ''
      const title = await agent.regenerateTitle(recentUsers, lastAssistant, { language: resolveTitleLanguageName() })
      if (!title) return { success: false, error: 'Title generation returned no result' }
      await this.renameSession(sessionId, title)
      return { success: true, title }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(({ rootPath: _rootPath, createdAt: _createdAt, ...info }) => info)
  }

  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    if (this.configWatchers.has(workspaceRootPath)) return

    const callbacks: ConfigWatcherCallbacks = {
      onLlmConnectionsChange: () => {
        this.eventSink(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' })
      },
      onAppThemeChange: theme => {
        this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
      },
      onDefaultPermissionsChange: () => {
        this.eventSink(RPC_CHANNELS.permissions.DEFAULTS_CHANGED, { to: 'all' }, null)
      },
      onSkillsListChange: skills => {
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async () => {
        const { loadAllSkills } = await import('@mkagent/shared/skills')
        this.broadcastSkillsChanged(workspaceId, loadAllSkills(workspaceRootPath))
      },
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return
        if (managed.isProcessing) managed.pendingExternalHeader = header
        else this.applyExternalSessionMetadata(managed, header)
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)
  }

  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void {
    this.configWatchers.get(workspaceRootPath)?.notifyFileChange(relativePath)
  }

  private broadcastSkillsChanged(workspaceId: string, skills: LoadedSkill[]): void {
    this.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills)
  }

  private applyExternalSessionMetadata(managed: ManagedSession, header: SessionHeader): void {
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
      managed.isFlagged = header.isFlagged ?? false
      this.sendEvent({
        type: managed.isFlagged ? 'session_flagged' : 'session_unflagged',
        sessionId: managed.id,
      }, managed.workspace.id)
    }
    if ((managed.isArchived ?? false) !== (header.isArchived ?? false)) {
      managed.isArchived = header.isArchived ?? false
      managed.archivedAt = header.archivedAt
      this.sendEvent({
        type: managed.isArchived ? 'session_archived' : 'session_unarchived',
        sessionId: managed.id,
      }, managed.workspace.id)
    }
    if (managed.name !== header.name) {
      managed.name = header.name
      this.sendEvent({ type: 'name_changed', sessionId: managed.id, name: header.name }, managed.workspace.id)
    }
  }

  getActiveSessionCount(workspaceId?: string): number {
    return [...this.sessions.values()].filter(managed => !this.isSessionUnpublished(managed.id) && managed.isProcessing && (!workspaceId || managed.workspace.id === workspaceId)).length
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    return [...this.sessions.values()].filter(managed => !this.isSessionUnpublished(managed.id) && managed.isProcessing).map(managed => ({
      sessionId: managed.id,
      workspaceId: managed.workspace.id,
      workspaceName: managed.workspace.name,
      title: managed.name,
      status: 'processing',
      createdAt: managed.createdAt,
    }))
  }

  async reinitializeAuth(connectionSlug?: string): Promise<void> {
    if (connectionSlug) return this.refreshConnectionRuntime(connectionSlug)
    await Promise.all([...new Set([...this.sessions.values()].map(item => item.llmConnection).filter(Boolean) as string[])].map(slug => this.refreshConnectionRuntime(slug)))
  }

  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.workspace.id !== workspaceId || managed.isProcessing) return null
    await this.flushSession(sessionId)
    return serializeSession(managed.workspace.rootPath, sessionId)
  }

  async importSession(workspaceId: string, bundle: SessionBundle, mode: DispatchMode): Promise<{ sessionId: string; warnings?: string[] }> {
    if (!validateBundle(bundle)) throw new Error('Invalid session bundle')
    const workspace = getWorkspaces().find(item => item.id === workspaceId || item.slug === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const created = await createStoredSession(workspace.rootPath, {
      name: bundle.session.header.name,
      workingDirectory: bundle.session.header.workingDirectory,
      permissionMode: bundle.session.header.permissionMode,
      model: bundle.session.header.model,
      llmConnection: bundle.session.header.llmConnection,
      hidden: bundle.session.header.hidden,
      isFlagged: bundle.session.header.isFlagged,
      parentSessionId: mode === 'fork' ? bundle.session.header.id : bundle.session.header.parentSessionId,
    })
    let stored: StoredSession
    try {
      const loaded = loadStoredSession(workspace.rootPath, created.id)
      if (!loaded) throw new Error('Failed to create imported session')
      stored = loaded
      stored.codingMode = bundle.session.header.codingMode
      if (bundle.files.some(file => file.relativePath === 'durable-store/session-id.txt' || file.relativePath === '.pi-sessions/legacy.jsonl')) {
        stored.sdkSessionId = bundle.session.header.sdkSessionId
      }
      stored.transferredSessionSummary = bundle.session.header.transferredSessionSummary
      stored.transferredSessionSummaryApplied = bundle.session.header.transferredSessionSummaryApplied
      const targetPath = getSessionStoragePath(workspace.rootPath, created.id)
      stored.messages = importSessionMessages(bundle, targetPath)
      stored.nativeArchivedMessages = importNativeArchivedMessages(bundle, targetPath)
      stored.tokenUsage = bundle.session.header.tokenUsage
      restoreSessionBundleFiles(bundle, targetPath)
      await saveStoredSession(stored)
    } catch (error) {
      if (!deleteStoredSession(workspace.rootPath, created.id)) log.error('Failed to roll back imported files', created.id)
      throw error
    }
    const managed = createManagedSession(stored, workspace, { messagesLoaded: true })
    this.sessions.set(managed.id, managed)
    this.notifySessionCreated(workspace.id, managed.id)
    return { sessionId: managed.id }
  }

  cleanup(): void {
    for (const clientId of this.pendingUIAttachments.keys()) this.disconnectExtensionUI(clientId)
    this.extensionUI.clear()
    for (const listener of this.prWatchSessionListeners) listener(null)
    this.prWatchSessionListeners.clear()
    for (const watcher of this.configWatchers.values()) watcher.stop()
    this.configWatchers.clear()
    for (const managed of this.sessions.values()) {
      void this.nativeOwners.cancel(managed.id)?.catch(error => log.warn('Native owner cleanup failed', error))
      managed.cancelHandoffWait?.()
      managed.agent?.destroy()
      unregisterSessionScopedToolCallbacks(managed.id)
    }
    this.turnCompleteListeners.clear()
    this.sessions.clear()
    this.inputClients.clear()
    this.browserHostPins.clear()
    this.rpcServer = null
    this.browserPaneManager = null
  }
}

export { sanitizeForTitle } from '@mkagent/server-core/domain'

function sameBoundPr(a: BoundPr, b: Pick<BoundPr, 'host' | 'owner' | 'repo' | 'number'>): boolean {
  return prEntryId(a) === prEntryId(b)
}
