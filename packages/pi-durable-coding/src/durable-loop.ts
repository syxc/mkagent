/** Public Pi loop APIs delegate scheduling to pi-durable tasks. */
import { EventStream } from '@earendil-works/pi-ai';
import type {
  AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, AgentToolCall,
  AgentToolCallOutcome, AgentToolResult, StreamFn,
} from './agent-runtime.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { DurableLoopBinding, runDurableToolCall } from './durable-coding/engine.ts';
import { getDefaultStreamFn } from './stream-fn.ts';
import type { AgentEventSink } from './native-operations.ts';
export { DEFAULT_AGENT_IDENTITY } from './native-operations.ts';
export type { AgentEventSink } from './native-operations.ts';

export type ToolCallHooks = Pick<AgentLoopConfig, 'beforeToolCall' | 'afterToolCall'>;

export interface RunToolCallOptions extends ToolCallHooks {
  tools: readonly AgentTool[];
  assistantMessage: AssistantMessage;
  context: AgentContext;
  signal?: AbortSignal;
  onUpdate?: (result: AgentToolResult<any>) => Promise<void> | void;
}

/** Tool failures return native error outcomes; execution and nested ownership belong to pi-durable. */
export function runToolCall(call: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
  return runDurableToolCall(call, options);
}

export async function runAgentLoop(
  prompts: AgentMessage[], context: AgentContext, config: AgentLoopConfig, emit: AgentEventSink,
  signal?: AbortSignal, streamFn: StreamFn = getDefaultStreamFn(),
): Promise<AgentMessage[]> {
  const binding = config.durable ?? new DurableLoopBinding();
  try {
    return await binding.run(prompts, context, config, emit, signal, streamFn);
  } finally {
    if (!config.durable) await binding.close();
  }
}

export function runAgentLoopContinue(
  context: AgentContext, config: AgentLoopConfig, emit: AgentEventSink, signal?: AbortSignal,
  streamFn: StreamFn = getDefaultStreamFn(),
): Promise<AgentMessage[]> {
  validateContinuation(context);
  return runAgentLoop([], context, config, emit, signal, streamFn);
}

export function agentLoop(
  prompts: AgentMessage[], context: AgentContext, config: AgentLoopConfig, signal?: AbortSignal,
  streamFn: StreamFn = getDefaultStreamFn(),
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = new EventStream<AgentEvent, AgentMessage[]>(
    event => event.type === 'agent_end', event => event.type === 'agent_end' ? event.messages : [],
  );
  const result = runAgentLoop(prompts, context, config, event => { stream.push(event); }, signal, streamFn);
  // EventStream has no rejection channel. Expose the task result while always ending the iterator.
  stream.result = () => result;
  void result.then(messages => stream.end(messages), () => stream.end([]));
  return stream;
}

export function agentLoopContinue(
  context: AgentContext, config: AgentLoopConfig, signal?: AbortSignal,
  streamFn: StreamFn = getDefaultStreamFn(),
): EventStream<AgentEvent, AgentMessage[]> {
  validateContinuation(context);
  return agentLoop([], context, config, signal, streamFn);
}

function validateContinuation(context: AgentContext) {
  if (!context.messages.length) throw new Error('Cannot continue: no messages in context');
  if (context.messages.at(-1)?.role === 'assistant') throw new Error('Cannot continue from message role: assistant');
}
