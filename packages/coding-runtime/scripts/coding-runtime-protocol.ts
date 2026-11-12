/** Publish the protocol needed by a host execution backend from the SDK's own dependency context. */
const agentValues = [
  'Agent', 'createErrorToolResult', 'createToolResultMessage', 'declareToolChanges',
  'emitToolExecutionEnd', 'emitToolResultMessage', 'prepareToolCall',
  'shouldTerminateToolBatch', 'streamAssistantResponse', 'streamProxy',
];
const agentTypes = [
  'AfterToolCallContext', 'AfterToolCallResult', 'AgentContext', 'AgentEvent', 'AgentEventSink',
  'AgentInitialState', 'AgentLoopConfig', 'AgentLoopTurnUpdate', 'AgentMessage', 'AgentOptions',
  'AgentRequestUpdate', 'AgentState', 'AgentTool', 'AgentToolCall', 'AgentToolCallOutcome',
  'AgentToolParams', 'AgentTurnContext', 'AgentTurnDecision', 'BeforeToolCallContext',
  'BeforeToolCallResult', 'CustomAgentMessages', 'FinishTurn', 'PrepareNextTurnContext',
  'PrepareRequest', 'PrepareRequestContext', 'ProxyAssistantMessageEvent', 'ProxyStreamOptions',
  'QueueMode', 'StreamFn', 'ThinkingLevel',
];
const modelValues = [
  'EventStream', 'PI_ATTRIBUTION', 'contentText',
  'createAssistantMessageEventStream',
];
const modelTypes = [
  'Api', 'AssistantMessage', 'AssistantMessageEvent', 'AuthCheck', 'AuthContext', 'ImageContent',
  'JsonValue', 'Message', 'Model', 'ModelThinkingLevel', 'Models', 'MutableModels', 'Provider',
  'SimpleStreamOptions', 'TextContent', 'ToolResultMessage', 'TranscriptContext', 'Usage', 'UserMessage',
];

export function codingRuntimeProtocolExports(declarations: boolean): string[] {
  return [
    `export { ${agentValues.join(', ')} } from "@earendil-works/pi-agent-core";`,
    `export { ${modelValues.join(', ')} } from "@earendil-works/pi-ai";`,
    'export { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";',
    'export { streamSimple } from "@earendil-works/pi-ai/compat";',
    ...(declarations ? [
      `export type { ${agentTypes.join(', ')} } from "@earendil-works/pi-agent-core";`,
      `export type { ${modelTypes.join(', ')} } from "@earendil-works/pi-ai";`,
    ] : []),
  ];
}
