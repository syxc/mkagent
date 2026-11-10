/** Durable execution bindings over the published Pi Coding session lifecycle. */
import {
  AgentSession as SDKAgentSession,
  type AgentSessionConfig as SDKAgentSessionConfig,
  type PromptOptions,
} from '@earendil-works/pi-coding-agent';
import { contentText,type AssistantMessage,type Model } from '@earendil-works/pi-ai';
import type { AgentActivityOutcome,NormalizedBuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';
import { runToolCall,type Agent,type AgentMessage } from './agent-runtime.ts';
import { convertToLlm } from './pi/core/messages.ts';
import { processImage } from './native-image-process.ts';
import { buildSystemPrompt,buildSystemPromptSections } from './native-system-prompt.ts';
import { createToolDefinitionFromAgentTool } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from './agent-runtime.ts';

export { markRuntimeStreamFunction,parseSkillBlock } from '@earendil-works/pi-coding-agent';
export type {
  AgentSessionEvent,AgentSessionEventListener,ExtensionBindings,ModelCycleResult,
  ModelMutationOptions,ParsedSkillBlock,PromptDisposition,PromptOptions,
  QueuedInputDisposition,SessionStats,
} from '@earendil-works/pi-coding-agent';

export interface AgentSessionConfig extends SDKAgentSessionConfig {
  agent: Agent;
}

export interface DurableSessionState {
  queues: ReturnType<Agent['exportDurableQueues']>;
  steering: string[];
  activeTools: string[];
  prepared?: AgentMessage[];
  queueTags: Record<'steering'|'followUp'|'nextTurn'|'pendingCustom',(string|null)[]>;
  followUp: string[];
  nextTurn: Extract<AgentMessage,{ role: 'custom' }>[];
  pendingCustom: Extract<AgentMessage,{ role: 'custom' }>[];
  pendingBash: Extract<AgentMessage,{ role: 'bashExecution' }>[];
  turnIndex: number;
  retryAttempt: number;
  failedResponse?: AssistantMessage;
  runPrompt?: NormalizedBuildSystemPromptOptions;
  overflowAttempted: boolean;
  systemPrompt: string;
  lastAssistant?: AssistantMessage;
  lastAssistantEntry?: string;
  lastOutcome: AgentActivityOutcome;
}

export class AgentSession extends SDKAgentSession {
  declare readonly agent: Agent;
  private _durableStartingMessages?: AgentMessage[];
  private _durablePreparingAction=false;
  private _durableQueueAdmissions=new Set<Promise<void>>();

  constructor(config: AgentSessionConfig) {
    super({ ...config,runToolCall,convertToLlm,processImage,promptDependencies: { buildSystemPrompt,buildSystemPromptSections } });
    this.agent.durable.bindSessionState(() => this.exportDurableState(),state =>
      this.restoreDurableState(state as ReturnType<AgentSession["exportDurableState"]>));
    this.agent.durable.bindInputQueues((inputs,cancelled) => {
      const queues=this.agent.exportDurableQueues();
      const dropped=new Set(cancelled);
      for(const kind of ["steering","followUp"] as const) {
        queues[kind]=queues[kind].filter(message => {
          if(!dropped.has(this.agent.durable.messageTag(message)??"")) return true;
          if(message.role==="user") {
            const text=contentText(message.content,"");
            const pending=kind==="steering"? this._steeringMessages:this._followUpMessages;
            const index=pending.indexOf(text);
            if(index!==-1) pending.splice(index,1);
          }
          return false;
        });
      }
      this.agent.restoreDurableQueues(queues);
      const present=new Set([...queues.steering,...queues.followUp,...this._pendingNextTurnMessages,
      ...this._pendingCustomMessages].map(message => this.agent.durable.messageTag(message)));
      for(const input of inputs) {
        if(present.has(input.tag)) continue;
        this.agent.durable.tagMessage(input.message,input.tag);
        if(input.kind==="steering") {
          this.agent.steer(input.message);
          if(input.text!==undefined) this._steeringMessages.push(input.text);
        } else if(input.kind==="followUp") {
          this.agent.followUp(input.message);
          if(input.text!==undefined) this._followUpMessages.push(input.text);
        } else {
          if(input.message.role!=="custom") throw new Error("Invalid durable custom input");
          (input.kind==="nextTurn"? this._pendingNextTurnMessages:this._pendingCustomMessages).push(input.message);
        }
        present.add(input.tag);
      }
    });
    this.agent.durable.bindSummary(async (model,context,options) =>
      (await this.agent.streamFunction(model,context,options)).result());

    if(config.cacheWarmer) config.cacheWarmer.onWarmed=entry => {
      const committed=this.sessionManager.getEntry(entry.id);
      if(committed?.type==='usage') this._emit({ type: 'entry_appended',entry: committed });
    };
  }

  cancelCacheWarming(): void { this._cacheWarmer?.cancel(); }

  protected override _resolveIdleWaitIfIdle(): void {
    if(this.agent.durable.inSessionPhase()) return;
    super._resolveIdleWaitIfIdle();
  }

  protected override async _canSelectModel(model: Model<any>): Promise<boolean> {
    return this.modelRuntime.hasConfiguredAuth(model.provider)||!!(await this.modelRuntime.checkAuth(model.provider));
  }

  protected override _getSummaryStream() { return this.agent.durable.summaryStream; }

  protected override _onMessagePersisted(message: AgentMessage,entryId: string): void {
    this.agent.durable.tagEntry(message,entryId);
  }

  protected override async _deferSettledAction(action: Parameters<NonNullable<SDKAgentSession['_deferSettledAction']>>[0]): Promise<boolean> {
    if(action.type==='custom') return this.agent.durable.deferSessionAction(action);
    const { preflightResult,...options }=action.options??{};
    return this.agent.durable.deferSessionAction({ type: 'prompt',text: action.text,options });
  }

  protected _acceptQueuedInput(kind: "steering"|"followUp"|"nextTurn"|"pendingCustom",message: AgentMessage,text?: string): Promise<void> {
    const admission=this.agent.durable.persistQueuedInputs({
      steering: kind==="steering"? [message]:[],followUp: kind==="followUp"? [message]:[],
      nextTurn: kind==="nextTurn"? [message]:[],pendingCustom: kind==="pendingCustom"? [message]:[],
      steeringText: text===undefined? []:[text],followUpText: text===undefined? []:[text],
    });
    this._durableQueueAdmissions.add(admission);
    void admission.finally(() => this._durableQueueAdmissions.delete(admission)).catch(() => { });
    return admission;
  }

  protected async _drainQueuedAdmissions(): Promise<void> {
    while(this._durableQueueAdmissions.size) await Promise.all([...this._durableQueueAdmissions]);
  }

  setBaseTools(tools: Record<string,AgentTool>): void {
    const previous=new Set(this._baseToolDefinitions.keys());
    const active=this.getActiveToolNames();
    this._baseToolsOverride=tools;
    this._baseToolDefinitions=new Map(Object.values(tools).map(tool =>
      [tool.name,createToolDefinitionFromAgentTool(tool)]));
    const added=[...this._baseToolDefinitions].filter(([name,definition]) =>
      !previous.has(name)&&definition.defaultActive!==false&&
      (definition.exposure===undefined||definition.exposure==="direct"||definition.exposure==="model-only"))
      .map(([name]) => name);
    this._refreshToolRegistry({
      activeToolNames: [...new Set([...active,
      ...added])]
    });
  }

  exportDurableState(): DurableSessionState {
    return {
      queues: this.agent.exportDurableQueues(),steering: this._steeringMessages,
      activeTools: this.getActiveToolNames(),
      prepared: this._durableStartingMessages,
      queueTags: {
        steering: this.agent.exportDurableQueues().steering.map(message => this.agent.durable.messageTag(message)??null),
        followUp: this.agent.exportDurableQueues().followUp.map(message => this.agent.durable.messageTag(message)??null),
        nextTurn: this._pendingNextTurnMessages.map(message => this.agent.durable.messageTag(message)??null),
        pendingCustom: this._pendingCustomMessages.map(message => this.agent.durable.messageTag(message)??null)
      },
      followUp: this._followUpMessages,nextTurn: this._pendingNextTurnMessages,
      pendingCustom: this._pendingCustomMessages,pendingBash: this._pendingBashMessages,
      turnIndex: this._turnIndex,retryAttempt: this._retryAttempt,
      failedResponse: this._failedResponse,runPrompt: this._runSystemPromptOptions,
      overflowAttempted: this._overflowRecoveryAttempted,systemPrompt: this.agent.state.systemPrompt,
      lastAssistant: this._lastAssistantMessage,
      lastAssistantEntry: this._lastAssistantMessage&&this._findPersistedMessageEntryId(this._lastAssistantMessage),
      lastOutcome: this._lastActivityOutcome
    };
  }

  restoreDurableState(state: ReturnType<AgentSession["exportDurableState"]>): void {
    if(state.activeTools) this.setActiveToolsByName(state.activeTools);
    this._durableStartingMessages=state.prepared;
    this.agent.restoreDurableQueues(state.queues);
    for(const kind of ["steering","followUp"] as const) state.queues[kind].forEach((message,index) => {
      const tag=state.queueTags?.[kind][index];
      if(tag) this.agent.durable.tagMessage(message,tag);
    });
    this._steeringMessages=state.steering;
    this._followUpMessages=state.followUp;
    this._pendingNextTurnMessages=state.nextTurn;
    this._pendingCustomMessages=state.pendingCustom;
    for(const kind of ["nextTurn","pendingCustom"] as const) state[kind].forEach((message,index) => {
      const tag=state.queueTags?.[kind]?.[index];
      if(tag) this.agent.durable.tagMessage(message,tag);
    });
    this._pendingBashMessages=state.pendingBash;
    this._turnIndex=state.turnIndex;
    this._retryAttempt=state.retryAttempt;
    this._failedResponse=state.failedResponse;
    this._runSystemPromptOptions=state.runPrompt;
    this._overflowRecoveryAttempted=state.overflowAttempted;
    this._lastAssistantMessage=state.lastAssistant;
    if(state.lastAssistant&&state.lastAssistantEntry)
      this._entryIdsByMessage.set(state.lastAssistant,state.lastAssistantEntry);
    this._lastActivityOutcome=state.lastOutcome;
  }

  async recoverDurable(onBound?: () => void): Promise<boolean> {
    await this.agent.durable.restoreSessionState();
    if(await this.agent.durable.pendingSession()===undefined&&await this.agent.durable.pendingRun()===undefined) return false;
    this._isAgentRunActive=true;
    this._agentRunAbortRequested=false;
    await this._runToSettlement(this._durableStartingMessages??[],onBound);
    return true;
  }

  protected async _runToSettlement(messages: AgentMessage[],onStarted?: () => void): Promise<void> {
    this._durableStartingMessages=messages;
    if(this._durablePreparingAction) return;
    try {
      await this.agent.durable.settleSession({
        start: () => this.agent.prompt(messages),
        prepared: async () => {
          let messages=this._durableStartingMessages??[];
          const preparation=this.agent.durable.preparedSessionInput()?.resume?.prepareAgentStart;
          if(preparation) {
            const content=preparation.content;
            const prompt=typeof content==="string"? content:content.flatMap(part => part.type==="text"? [part.text]:[]).join("\n");
            const images=typeof content==="string"? undefined:content.filter(part => part.type==="image");
            messages=await this._prepareRun({ messageType: "user",prompt,images });
            if(preparation.placed) messages=messages.filter(message => message.role!=="user");
            else if(preparation.tag) for(const message of messages)
              if(message.role==="user") this.agent.durable.tagMessage(message,preparation.tag);
          }
          await this.agent.prompt(messages);
        },
        continue: () => this.agent.continue(),
        recover: (child,onBound) => this.agent.resumeDurable(onBound,child),
        post: () => this._handlePostAgentRun(),
        beforeSettle: () => this._runBeforeSettleBoundary(),
        aborted: () => this._agentRunAbortRequested,
        action: async action => {
          this._isAgentRunActive=false;
          this._durablePreparingAction=true;
          this._durableStartingMessages=undefined;
          try {
            if(action.type==="prompt") await this.prompt(action.text,action.options);
            else await this.sendCustomMessage(action.message,action.options);
            return this._durableStartingMessages!==undefined;
          } finally { this._durablePreparingAction=false; }
        },
        finalize: async completion => {
          if(completion.status==="failed") this._lastActivityOutcome="error";
          if(completion.status==="aborted") this._agentRunAbortRequested=true;
          if(this._agentRunAbortRequested) this._finishCancelledRetry();
          this._failedResponse=undefined;
          this._runSystemPromptOptions=undefined;
          this._durableStartingMessages=undefined;
          this._flushPendingBashMessages();
          this._flushPendingCustomMessages();
          await this._emitAgentSettled();
        },
      },onStarted);
    } finally {
      this._isAgentRunActive=false;
      this._resolveIdleWaitIfIdle();
    }
  }
}
