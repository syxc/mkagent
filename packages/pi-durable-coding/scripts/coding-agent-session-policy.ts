/** Expose session execution seams without replacing the published lifecycle algorithms. */
export function codingAgentSessionPolicy(source: string, declarations: boolean): string {
  let body = source;
  const edit = (before: string, after: string) => {
    if (body.split(before).length !== 2) throw new Error('Published AgentSession boundary changed: ' + before);
    body = body.replace(before, after);
  };
  if (declarations) {
    body = 'import type { runToolCall } from "@earendil-works/pi-agent-core";\n'
      + 'import type { convertToLlm } from "./messages.ts";\n'
      + 'import type { processImage } from "../utils/image-process.ts";\n'
      + 'import type { createAllToolDefinitions } from "./tools/index.ts";\n'
      + 'import type { createLocalBashOperations } from "./tools/bash.ts";\n'
      + 'import type { AssistantMessage } from "@earendil-works/pi-ai/compat";\n'
      + 'import type { AgentActivityOutcome } from "./extensions/types.ts";\n'
      + 'import type { BeforeAgentStartTrigger } from "./extensions/runner.ts";\n'
      + 'import type { BashExecutionMessage } from "./messages.ts";\n'
      + 'import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions, SystemPromptSections } from "./system-prompt.ts";\n'
      + 'import type { SourceInfo } from "./source-info.ts";\n' + body;
    edit('export interface AgentSessionConfig {', `export interface AgentSessionConfig {
    runToolCall?: typeof runToolCall;
    convertToLlm?: typeof convertToLlm;
    processImage?: typeof processImage;
    createAllToolDefinitions?: typeof createAllToolDefinitions;
    createLocalBashOperations?: typeof createLocalBashOperations;
    wrapTool?: (tool: AgentTool, source?: SourceInfo) => AgentTool;
    onAction?: (work: () => Promise<void>) => Promise<void>;
    onToolsChanged?: (tools: AgentTool[]) => void;
    captureUserInput?: (content: string | (TextContent | ImageContent)[]) => Pick<PromptOptions, "hostMessageId" | "hostUserInput">;
    promptDependencies?: {
        buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
        buildSystemPromptSections: (options: BuildSystemPromptOptions) => SystemPromptSections;
    };`);
    edit('export interface PromptOptions {', `export interface PromptOptions {
    /** Product metadata stays separate from durable admission identity. */
    hostMessageId?: string;
    hostUserInput?: { version: 1; content: string | (TextContent | ImageContent)[] };
    hostContextPrefix?: string;`);
    const fields: Record<string, string> = {
      _isAgentRunActive: 'boolean', _agentRunAbortRequested: 'boolean',
      _steeringMessages: 'string[]', _followUpMessages: 'string[]',
      _pendingNextTurnMessages: 'CustomMessage[]', _pendingCustomMessages: 'CustomMessage[]',
      _pendingBashMessages: 'BashExecutionMessage[]', _turnIndex: 'number', _retryAttempt: 'number',
      _failedResponse: 'AssistantMessage | undefined', _runSystemPromptOptions: 'NormalizedBuildSystemPromptOptions | undefined',
      _overflowRecoveryAttempted: 'boolean', _lastAssistantMessage: 'AssistantMessage | undefined',
      _lastActivityOutcome: 'AgentActivityOutcome', _baseToolsOverride: 'Record<string, AgentTool> | undefined',
      _baseToolDefinitions: 'Map<string, ToolDefinition>', _entryIdsByMessage: 'WeakMap<object, string>',
      _cacheWarmer: 'AgentSessionConfig["cacheWarmer"]',
    };
    for (const [name, type] of Object.entries(fields)) {
      const readonly = name === '_entryIdsByMessage' ? 'readonly ' : '';
      const optional = ['_runSystemPromptOptions', '_baseToolsOverride', '_cacheWarmer'].includes(name) ? '?' : '';
      edit(`    private ${readonly}${name}${optional};`, `    protected ${readonly}${name}: ${type};`);
    }
    const methods: Record<string, string> = {
      _emit: '(event: AgentSessionEvent): void',
      _findPersistedMessageEntryId: '(message: AgentMessage): string | undefined',
      _refreshToolRegistry: '(options?: { activeToolNames?: string[] }): void',
      _prepareRun: '(trigger: BeforeAgentStartTrigger, hostMessageId?: string, hostUserInput?: PromptOptions["hostUserInput"]): Promise<AgentMessage[]>',
      _handlePostAgentRun: '(): Promise<boolean>', _runBeforeSettleBoundary: '(): Promise<boolean>',
      _finishCancelledRetry: '(): void', _flushPendingBashMessages: '(): void',
      _flushPendingCustomMessages: '(): void', _emitAgentSettled: '(): Promise<void>',
      _resolveIdleWaitIfIdle: '(): void',
    };
    for (const [name, signature] of Object.entries(methods)) edit(`    private ${name};`, `    protected ${name}${signature};`);
    edit('    constructor(config: AgentSessionConfig);', `    protected _runToSettlement?(messages: AgentMessage[], onStarted?: () => void): Promise<void>;
    protected _acceptQueuedInput?(kind: "steering" | "followUp" | "nextTurn" | "pendingCustom", message: AgentMessage, text?: string): Promise<void>;
    protected _drainQueuedAdmissions?(): Promise<void>;
    protected _onMessagePersisted?(message: AgentMessage, entryId: string): void;
    protected _deferSettledAction?(action: { type: "prompt"; text: string; options?: PromptOptions } | { type: "custom"; message: Omit<CustomMessage, "role" | "timestamp">; options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } }): Promise<boolean>;
    protected _getSummaryStream?(): StreamFn;
    protected _canSelectModel?(model: Model<any>): Promise<boolean>;
    constructor(config: AgentSessionConfig);`);
    return body;
  }
  edit('    constructor(config) {', `    _runNestedToolCall = runToolCall;
    _convertToLlm = convertToLlm;
    _processImage = processImage;
    _createAllToolDefinitions = createAllToolDefinitions;
    _createLocalBashOperations = createLocalBashOperations;
    _wrapTool;
    _onAction;
    _onToolsChanged;
    _captureUserInput;
    _renderSystemPrompt = buildSystemPrompt;
    _renderSystemPromptSections = buildSystemPromptSections;
    constructor(config) {`);
  edit('        this._baseToolsOverride = config.baseToolsOverride;', `        this._baseToolsOverride = config.baseToolsOverride;
        this._runNestedToolCall = config.runToolCall ?? runToolCall;
        this._convertToLlm = config.convertToLlm ?? convertToLlm;
        this._processImage = config.processImage ?? processImage;
        this._createAllToolDefinitions = config.createAllToolDefinitions ?? createAllToolDefinitions;
        this._createLocalBashOperations = config.createLocalBashOperations ?? createLocalBashOperations;
        this._wrapTool = config.wrapTool;
        this._onAction = config.onAction;
        this._onToolsChanged = config.onToolsChanged;
        this._captureUserInput = config.captureUserInput;
        this._renderSystemPrompt = config.promptDependencies?.buildSystemPrompt ?? buildSystemPrompt;
        this._renderSystemPromptSections = config.promptDependencies?.buildSystemPromptSections ?? buildSystemPromptSections;`);
  edit('return runToolCall(toolCall, {', 'return this._runNestedToolCall(toolCall, {');
  edit(': createAllToolDefinitions(this._cwd, {', ': this._createAllToolDefinitions(this._cwd, {');
  edit('options?.operations ?? createLocalBashOperations({ shellPath })',
    'options?.operations ?? this._createLocalBashOperations({ shellPath })');
  edit('await processImage(Buffer.from(image.data, "base64"), image.mimeType, {',
    'await this._processImage(Buffer.from(image.data, "base64"), image.mimeType, {');
  for (const messages of ['this.messages', 'context.messages', 'projection.messages']) {
    edit(`convertToLlm(${messages})`, `this._convertToLlm(${messages})`);
  }
  edit('return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);',
    'return this._renderSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);');
  edit('buildSystemPromptSections(options));', 'this._renderSystemPromptSections(options));');
  edit('new ModelRegistry(this._modelRuntime));',
    'new ModelRegistry(this._modelRuntime), { buildSystemPrompt: this._renderSystemPrompt });');
  edit('        const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;',
    '        this._rebuildSystemPrompt(this.getActiveToolNames());\n        const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;');
  edit('        this._toolRegistry = toolRegistry;', `        this._toolRegistry = this._wrapTool ? new Map([...toolRegistry].map(([name, tool]) =>
            [name, this._wrapTool(tool, definitionRegistry.get(name)?.sourceInfo)])) : toolRegistry;
        this._onToolsChanged?.([...this._toolRegistry.values()]);`);
  for (const call of ['sendCustomMessage(message, options)', 'sendUserMessage(content, options)']) {
    edit(`this.${call}.catch((err) => {`,
      `(this._onAction ? this._onAction(() => this.${call}) : this.${call}).catch((err) => {`);
  }
  edit('if (!this._modelRuntime.hasConfiguredAuth(model.provider))',
    'if (!(this._canSelectModel ? await this._canSelectModel(model) : this._modelRuntime.hasConfiguredAuth(model.provider)))');
  edit('        onStarted?.();', '        if (!this._runToSettlement) onStarted?.();');
  edit('        this._pendingToolNames.clear();\n        try {', `        this._pendingToolNames.clear();
        if (this._runToSettlement) return this._runToSettlement(messages, onStarted);
        try {`);
  edit('        this._deferredSettledActions.push(async () => await this.prompt(text, options));', `        if (this._deferSettledAction && await this._deferSettledAction({ type: "prompt", text, options })) {
                options?.preflightResult?.("queued");
                return;
            }
            this._deferredSettledActions.push(async () => await this.prompt(text, options));`);
  edit('                this._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));',
    '                if (this._deferSettledAction && await this._deferSettledAction({ type: "custom", message, options })) return;\n                this._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));');
  edit('        await this._emitExtensionEvent(event);',
    '        await this._emitExtensionEvent(event);\n        if (this._drainQueuedAdmissions) await this._drainQueuedAdmissions();');
  edit('            await this._extensionRunner.emit({ type: "agent_settled", aborted });',
    '            await this._extensionRunner.emit({ type: "agent_settled", aborted });\n            if (this._drainQueuedAdmissions) await this._drainQueuedAdmissions();');
  edit('            this._commitBoundaryDrafts(result.entries);',
    '            if (this._drainQueuedAdmissions) await this._drainQueuedAdmissions();\n            this._commitBoundaryDrafts(result.entries);');
  edit('            if (entryId)\n                this._entryIdsByMessage.set(event.message, entryId);', `            if (entryId) {
                this._entryIdsByMessage.set(event.message, entryId);
                this._onMessagePersisted?.(event.message, entryId);
            }`);
  edit('        this.sessionManager.appendCustomMessageEntry(appMessage.customType, appMessage.content, appMessage.display, appMessage.details);',
    '        const entryId = this.sessionManager.appendCustomMessageEntry(appMessage.customType, appMessage.content, appMessage.display, appMessage.details);\n        this._onMessagePersisted?.(appMessage, entryId);');
  edit('        const targetRecord = target;', '        const targetRecord = target;\n        const hostMessageId = targetRecord.hostMessageId;\n        const hostUserInput = targetRecord.hostUserInput;');
  edit('        Object.assign(targetRecord, replacement);', `        Object.assign(targetRecord, replacement);
        if (typeof hostMessageId === "string") targetRecord.hostMessageId = hostMessageId;
        else delete targetRecord.hostMessageId;
        if (hostUserInput !== undefined) targetRecord.hostUserInput = hostUserInput;
        else delete targetRecord.hostUserInput;`);
  edit('async _startRun(trigger, onStarted)', 'async _startRun(trigger, onStarted, hostMessageId, hostUserInput)');
  edit('this._prepareRun(trigger);', 'this._prepareRun(trigger, hostMessageId, hostUserInput);');
  edit('async _prepareRun(trigger)', 'async _prepareRun(trigger, hostMessageId, hostUserInput)');
  edit('                role: "user",\n                content:',
    '                role: "user",\n                ...(hostMessageId ? { hostMessageId } : {}),\n                ...(hostUserInput ? { hostUserInput } : {}),\n                content:');
  edit('() => preflightResult?.("started"));', '() => preflightResult?.("started"), options?.hostMessageId, options?.hostUserInput);');
  edit('        // If streaming, queue via steer() or followUp() based on option',
    '        if (options?.hostContextPrefix) expandedText = options.hostContextPrefix + expandedText;\n        // If streaming, queue via steer() or followUp() based on option');
  for (const [queue, method, kind, texts] of [
    ['Steer', 'steer', 'steering', '_steeringMessages'],
    ['FollowUp', 'followUp', 'followUp', '_followUpMessages'],
  ]) {
    edit(`async _queue${queue}(text, images)`, `async _queue${queue}(text, images, hostMessageId, hostUserInput)`);
    edit(`this._queue${queue}(expandedText, currentImages);`,
      `this._queue${queue}(expandedText, currentImages, options?.hostMessageId, options?.hostUserInput);`);
    edit(`        this.${texts}.push(text);\n        this._emitQueueUpdate();`, '');
    const before = method === 'steer'
      ? '        this.agent.steer({\n            role: "user",\n            content,\n            timestamp: Date.now(),\n        });'
      : '        this.agent.followUp({ role: "user", content, timestamp: Date.now() });';
    edit(before, `        const message = { role: "user", content, timestamp: Date.now(), ...(hostMessageId ? { hostMessageId } : {}), ...(hostUserInput ? { hostUserInput } : {}) };
        if (this._acceptQueuedInput) await this._acceptQueuedInput("${kind}", message, text);
        this.${texts}.push(text);
        this._emitQueueUpdate();
        this.agent.${method}(message);`);
  }
  for (const [target, kind] of [['_pendingNextTurnMessages', 'nextTurn'], ['_pendingCustomMessages', 'pendingCustom']]) {
    edit(`            this.${target}.push(appMessage);`,
      `            if (this._acceptQueuedInput) await this._acceptQueuedInput("${kind}", appMessage);\n            this.${target}.push(appMessage);`);
  }
  edit('        else if (this.isStreaming && options?.triggerTurn !== false) {',
    '        else if (this.isStreaming && options?.triggerTurn !== false) {\n            if (this._acceptQueuedInput) await this._acceptQueuedInput(options?.deliverAs === "followUp" ? "followUp" : "steering", appMessage);');
  edit('        // Normalize content to text string + optional images',
    '        const { hostMessageId, hostUserInput } = this._captureUserInput?.(content) ?? {};\n        // Normalize content to text string + optional images');
  edit('            images,\n            source: "extension",', '            images,\n            source: "extension",\n            hostMessageId,\n            hostUserInput,');
  edit('this.agent.streamFunction, request.env', '(this._getSummaryStream?.() ?? this.agent.streamFunction), request.env');
  for (const indent of ['                    ', '            ']) {
    edit(indent + 'streamFn: this.agent.streamFunction,', indent + 'streamFn: this._getSummaryStream?.() ?? this.agent.streamFunction,');
  }
  return body;
}
