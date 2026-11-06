import { randomUUID } from 'node:crypto';
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import {
  NestedCallDoc, ToolTask, defineTool, type NestedToolExecutionResult,
  type ToolExecutionApi, type ToolExecutionResult,
} from '@earendil-works/pi-durable';

export const NATIVE_CODEMODE_FORWARD = 'pi.codemode.native.forward';

export interface NativeCodemodeForwardInput {
  token: string;
  vmId: number;
  name: string;
  args?: JsonValue;
}

export type NativeCodemodeForwardHandler = (
  input: NativeCodemodeForwardInput, api: ToolExecutionApi, context: Context,
) => Promise<ToolExecutionResult>;

export interface NativeCodemodeForwardLease {
  execute(vmId: number, name: string, args: JsonValue | undefined, context: Context): Promise<NestedToolExecutionResult>;
  join(): Promise<void>;
  dispose(): void;
}

function forwardInput(value: unknown): NativeCodemodeForwardInput {
  if (typeof value !== 'object' || value === null ||
      !('token' in value) || typeof value.token !== 'string' ||
      !('vmId' in value) || typeof value.vmId !== 'number' ||
      !Number.isSafeInteger(value.vmId) || value.vmId < 1 ||
      !('name' in value) || typeof value.name !== 'string') {
    throw new Error('Invalid native codemode forwarding input');
  }
  return { token: value.token, vmId: value.vmId, name: value.name,
    ...(!('args' in value) || value.args === undefined ? {} : { args: copyJson(value.args) }) };
}

export function nativeCodemodeForwardTool(resolve: (conversation: ToolExecutionApi['conversationId']) => {
  forward(input: NativeCodemodeForwardInput, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult>;
}) {
  return defineTool({
    name: NATIVE_CODEMODE_FORWARD,
    description: 'Internal native codemode dispatch',
    parameters: {
      type: 'object',
      properties: { token: { type: 'string' }, vmId: { type: 'integer', minimum: 1 }, name: { type: 'string' }, args: {} },
      required: ['token', 'vmId', 'name'], additionalProperties: false,
    },
    structuredOutputSchema: {},
    outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    callers: ['tools'],
    replay: 'unsafe',
    execute: (args, api, context) => resolve(api.conversationId).forward(forwardInput(args), api, context),
  });
}

/** Tokens stay local to a binding; the stable registry tool routes by conversation first. */
export class NativeCodemodeForwarders {
  private readonly bindings = new Map<string, {
    parent: ToolExecutionApi;
    handler: NativeCodemodeForwardHandler;
    calls: Map<number, { input: NativeCodemodeForwardInput; serialized: string; entered: boolean }>;
  }>();

  constructor(private readonly scoped: <T>(
    api: ToolExecutionApi, context: Context, work: () => Promise<T>,
  ) => Promise<T>, private readonly currentApi: () => ToolExecutionApi) {}

  async register(parent: ToolExecutionApi, context: Context, handler: NativeCodemodeForwardHandler): Promise<NativeCodemodeForwardLease> {
    const memo = 'mkagent.native.codemode.forward';
    let token = await parent.memo(memo, context);
    if (token === undefined) {
      token = randomUUID();
      token = await parent.memo(memo, token, context);
    }
    if (typeof token !== 'string') throw new Error('Invalid native codemode forwarding token');
    if (this.bindings.has(token)) throw new Error('Native codemode forwarding is already active');
    const binding = { parent, handler, calls: new Map<number, {
      input: NativeCodemodeForwardInput; serialized: string; entered: boolean;
    }>() };
    this.bindings.set(token, binding);
    const waiting = new Set<Promise<unknown>>();
    const failures = new Set<unknown>();
    // VM cancellation stops the effect through the host policy. Keep the official
    // wait alive so lease cleanup joins its receipt, rather than only its effect.
    const joined = withAbortSignal(new AbortController().signal, context);
    return {
      execute: (vmId, name, args, callContext) => {
        callContext.abortSignal?.throwIfAborted();
        if (this.bindings.get(token) !== binding) throw new Error('Native codemode invocation has ended');
        const input = { token, vmId, name, ...(args === undefined ? {} : { args: copyJson(args) }) };
        const previous = binding.calls.get(vmId);
        const serialized = JSON.stringify(input);
        if (previous && previous.serialized !== serialized) throw new Error('Native codemode call identity changed');
        binding.calls.set(vmId, previous ?? { input, serialized, entered: false });
        const execution = Promise.resolve().then(() =>
          parent.executeTool(NATIVE_CODEMODE_FORWARD, input, joined, { key: `c${vmId}` }));
        waiting.add(execution);
        void execution.then(() => waiting.delete(execution), error => {
          failures.add(error);
          waiting.delete(execution);
        });
        return execution;
      },
      join: async () => {
        await Promise.allSettled([...waiting]);
        if (failures.size === 1) throw [...failures][0];
        if (failures.size > 1) throw new AggregateError([...failures], 'Native codemode forwarding failed');
      },
      dispose: () => { if (this.bindings.get(token) === binding) this.bindings.delete(token); },
    };
  }

  async forward(input: NativeCodemodeForwardInput, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
    const binding = this.bindings.get(input.token);
    const expected = binding?.calls.get(input.vmId);
    if (!binding || !expected || JSON.stringify(input) !== expected.serialized) {
      throw new Error('Native codemode call is not bound to this invocation');
    }
    const parent = binding.parent;
    const key = `c${input.vmId}`;
    const record = await api.getTask(api.taskId, context);
    const source = record?.input;
    const call = source && typeof source === 'object' && !Array.isArray(source) ? source.call : undefined;
    const nested = source && typeof source === 'object' && !Array.isArray(source) ? source : undefined;
    if (!record || record.kind !== ToolTask.definition.name || record.owner !== parent.taskId ||
        record.id !== api.taskId || record.conversationId !== parent.conversationId ||
        api.conversationId !== parent.conversationId || !nested || nested.kind !== 'nested' ||
        nested.parent !== parent.taskId || nested.parentCallId !== parent.callId || nested.key !== key ||
        !call || typeof call !== 'object' || Array.isArray(call) || call.type !== 'toolCall' ||
        call.name !== NATIVE_CODEMODE_FORWARD || call.id !== api.callId || api.callId !== `${parent.callId}/${key}` ||
        JSON.stringify(call.arguments) !== expected.serialized ||
        (await api.snapshot(NestedCallDoc, parent.taskId, key, context))?.taskId !== api.taskId) {
      throw new Error('Native codemode forwarding task does not own this call');
    }
    const owner = await api.getTask(parent.taskId, context);
    if (!owner || owner.conversationId !== parent.conversationId ||
        !['pi.coding.tool', ToolTask.definition.name].includes(owner.kind) || owner.abortRequested) {
      throw new Error('Native codemode parent is not active');
    }
    if (expected.entered) throw new Error('Native codemode call was already dispatched');
    expected.entered = true;
    return this.scoped(api, context, () => binding.handler(input, this.currentApi(), context));
  }
}
