/** Inject host constructors and policies without copying SDK session assembly. */
export function codingSessionFactoryPolicy(source: string, declaration: boolean): string {
  const edit = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error('Published session factory changed: ' + before);
    source = source.replace(before, after);
  };
  if (declaration) {
    source = 'import type { Agent, AgentOptions } from "@earendil-works/pi-agent-core";\n'
      + 'import type { AgentSessionConfig } from "./agent-session.ts";\n'
      + 'import type { DefaultResourceLoaderOptions } from "./resource-loader.ts";\n' + source;
    edit('export interface CreateAgentSessionOptions {', `export interface CreateAgentSessionOptions {
    /** Skip bootstrap entries when the host restores an already committed tree. */
    initializeSessionMetadata?: boolean;
    baseToolsOverride?: AgentSessionConfig["baseToolsOverride"];
    wrapTool?: AgentSessionConfig["wrapTool"];
    onAction?: AgentSessionConfig["onAction"];
    onToolsChanged?: AgentSessionConfig["onToolsChanged"];
    captureUserInput?: AgentSessionConfig["captureUserInput"];`);
    edit('/** Result from createAgentSession */', `/** Host bindings; SDK selection, provider hooks and lifecycle assembly stay shared. */
export interface CreateAgentSessionDependencies<AgentType extends Agent, SessionType extends AgentSession> {
    createAgent: (options: AgentOptions) => AgentType;
    createSession: (config: Omit<AgentSessionConfig, "agent"> & { agent: AgentType }) => SessionType;
    extensionLoader?: DefaultResourceLoaderOptions["extensionLoader"];
    convertToLlm?: typeof import("./messages.ts").convertToLlm;
    cacheWarmingAction?: <T>(work: () => Promise<T>) => Promise<T>;
    identityVersion?: string;
}
/** Result from createAgentSession */`);
    const signature = 'export declare function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;';
    edit(signature, signature + '\nexport declare function createAgentSession<AgentType extends Agent, SessionType extends AgentSession>(options: CreateAgentSessionOptions, dependencies: CreateAgentSessionDependencies<AgentType, SessionType>): Promise<Omit<CreateAgentSessionResult, "session"> & { session: SessionType }>;');
    return source;
  }
  edit('export async function createAgentSession(options = {}) {', `export async function createAgentSession(options = {}, dependencies) {
    const createAgent = dependencies?.createAgent ?? (config => new Agent(config));
    const createSession = dependencies?.createSession ?? (config => new AgentSession(config));`);
  edit('new DefaultResourceLoader({ cwd, agentDir, settingsManager })',
    'new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionLoader: dependencies?.extensionLoader })');
  edit('const converted = convertToLlm(messages);', 'const converted = (dependencies?.convertToLlm ?? convertToLlm)(messages);');
  edit('async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action);',
    'async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action, dependencies?.cacheWarmingAction);');
  edit('const headerRunner = extensionRunnerRef.current;', `const headerRunner = extensionRunnerRef.current;
        const identity = getClientIdentity(settingsManager);
        identity.version = dependencies?.identityVersion ?? identity.version;`);
  edit('identity: getClientIdentity(settingsManager),', 'identity,');
  edit('const agent = new Agent({', 'const agent = createAgent({');
  edit('    if (hasExistingSession) {\n        if (!hasThinkingEntry) {',
    '    if (options.initializeSessionMetadata !== false && hasExistingSession) {\n        if (!hasThinkingEntry) {');
  edit('    else {\n        // Save initial model and thinking level for new sessions',
    '    else if (options.initializeSessionMetadata !== false) {\n        // Save initial model and thinking level for new sessions');
  edit('const session = new AgentSession({', 'const session = createSession({');
  edit('        customTools: options.customTools,', `        customTools: options.customTools,
        baseToolsOverride: options.baseToolsOverride,
        wrapTool: options.wrapTool,
        onAction: options.onAction,
        onToolsChanged: options.onToolsChanged,
        captureUserInput: options.captureUserInput,`);
  return source;
}
