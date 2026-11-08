/** Add a response-only task without changing historical GenerationTask checkpoints. */
import { replaceOnce } from './durable-boundary-source.ts';

export function patchGenerationResponse(source: string): string {
  source = replaceOnce(source, 'async function streamResponse(\n\truntime: Runtime,',
    'async function streamResponse<I, S, R>(\n\truntime: TaskRuntime<I, S, R, GenerationHooks>,');
  source = replaceOnce(source, '\tattempt: number,\n\tcontext: Context,\n): Promise<AssistantMessage> {',
    '\tattempt: number,\n\tcontext: Context,\n  observe?: boolean,\n): Promise<AssistantMessage> {');
  source = replaceOnce(source, 'const observeCoding = agentHooks(await runtime.agent(context), GenerationTask.definition.name)',
    'const observeCoding = observe ?? agentHooks(await runtime.agent(context), GenerationTask.definition.name)');
  return source + responseTask;
}

const responseTask = `

/** A prepared request. Credentials and callbacks belong to the runtime's Models binding. */
export type GenerationResponseInput = {
  model: ModelRef;
  messages: Message[];
  thinkingLevel?: ModelThinkingLevel;
  streamOptions?: ConversationStreamOptions;
};
export type GenerationResponseCheckpoint = { phase: "request"; started?: true };
export type GenerationResponseResult = { message: AssistantMessage };
type ResponseRuntime = TaskRuntime<GenerationResponseInput, GenerationResponseCheckpoint, GenerationResponseResult, GenerationHooks>;

/** Reuse the generation stream and progress writer without classifying or appending its response. */
export const GenerationResponseTask = defineTask<GenerationResponseInput, GenerationResponseCheckpoint, GenerationResponseResult, GenerationHooks>({
  name: "pi.generation-response",
  version: 1,
  initial: () => ({ phase: "request" }),
  phases: {
    request: async (task, runtime, context) => {
      if (task.state.checkpoint.started) {
        return endResponse(runtime, { status: "failed", error: { message: "Prepared generation was interrupted; the request was not repeated" } }, context);
      }
      const model = runtime.models.getModel(task.input.model.provider, task.input.model.modelId);
      if (!model) return endResponse(runtime, { status: "failed", error: { message: "Prepared generation model is unavailable" } }, context);
      await runtime.commit(async tx => {
        (await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: 1 };
        return { status: "running", checkpoint: { phase: "request", started: true } };
      }, context);
      let message: AssistantMessage;
      try {
        message = await streamResponse(runtime, model, task.input.messages, {
          ...task.input.streamOptions, signal: runtime.signal, reasoning: task.input.thinkingLevel === "off" ? undefined : task.input.thinkingLevel,
        }, 1, context, true);
      } catch (error) {
        runtime.signal.throwIfAborted();
        return endResponse(runtime, { status: "failed", error: { message: error instanceof Error ? error.message : String(error) } }, context);
      }
      return endResponse(runtime, { status: "completed", result: { message } }, context);
    },
  },
  abort: async (_task, runtime, context) => endResponse(runtime, { status: "aborted" }, context),
});

async function endResponse(runtime: ResponseRuntime, outcome: TaskOutcome<GenerationResponseResult>, context: Context): Promise<void> {
  await runtime.commit(async tx => {
    delete (await tx.doc(LiveDoc, runtime.conversationId)).generation;
    return { status: "terminal", outcome };
  }, context);
}
`;
