import type { AgentToolCallOutcome, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Models, Usage } from '@earendil-works/pi-ai';
import { copyJson } from '@earendil-works/chord';
import type { NestedToolExecutionResult, TaskId, ToolExecutionResult } from '@earendil-works/pi-durable';
import { prepareCodemodeModelCall, type CodemodePreparedModelCall } from '@earendil-works/pi-durable/codemode';
import { combineUsage } from '@earendil-works/pi-coding-agent';
import {
  CODEMODE_DOCS_PATH, type CodemodeModelRuntime, type CodemodeNestedCall, type CodemodeToolDetails,
} from '../native-codemode.ts';

type Call = { readonly id: number; readonly name: string; readonly args: unknown };
const prefix = 'pi.codemode.';
const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 3)}...` : text;
export const nativeResultText = (result: AgentToolResult<unknown>) =>
  result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');

/** Keep Native's display identities and usage view over the durable executor's VM call IDs. */
export class NativeCodemodeCalls {
  private readonly rows = new Map<number, CodemodeNestedCall>();
  private readonly started = new Map<number, number>();
  private readonly prepared = new Map<number, CodemodePreparedModelCall>();
  private readonly accounted = new Set<TaskId>();
  private modelCount = 0;
  usage?: Usage;

  constructor(private readonly callId: string, private readonly publish: () => void,
    private readonly models?: CodemodeModelRuntime,
    private readonly nativeName: (name: string) => string = name => name) {}

  snapshot(): CodemodeToolDetails { return { calls: [...this.rows.values()].map(row => ({ ...row })) }; }

  prepare(call: Call): void {
    if (!this.isModel(call.name)) return;
    if (!this.models) throw new Error('Model calls need a session');
    const args = call.args as { model: unknown; context: unknown };
    const models = this.models;
    this.prepared.set(call.id, prepareCodemodeModelCall(call.name.slice(prefix.length) as
      'models.classify' | 'models.generateImages', args, {
      getModelOfType: models.getModelOfType.bind(models),
      classify: (model, context, options) => models.classify(model, context, { signal: options?.signal }),
      generateImages: (model, context, options) => models.generateImages(model, context, { signal: options?.signal }),
    }, { docsPath: CODEMODE_DOCS_PATH }));
  }

  start(call: Call): void {
    if (this.rows.has(call.id)) return;
    const model = this.prepared.get(call.id);
    const isModel = this.isModel(call.name);
    const name = isModel ? call.name.slice(prefix.length) : this.nativeName(call.name);
    const selector = (call.args as { model?: { provider?: unknown; id?: unknown } } | undefined)?.model;
    this.started.set(call.id, performance.now());
    this.rows.set(call.id, {
      id: isModel ? `${this.callId}/${name}/${++this.modelCount}` : `${this.callId}/?`,
      name,
      args: isModel ? `${model?.model.provider ?? selector?.provider}/${model?.model.id ?? selector?.id}`
        : call.args === undefined ? '' : cut(JSON.stringify(call.args) ?? '', 200),
      status: 'running',
    });
    this.publish();
  }

  model(id: number): CodemodePreparedModelCall | undefined { return this.prepared.get(id); }
  isModel(name: string): boolean {
    return name === `${prefix}models.classify` || name === `${prefix}models.generateImages`;
  }

  /** Store display metadata with the official receipt, which survives the forwarding handler. */
  receipt(id: number, result: ToolExecutionResult): ToolExecutionResult {
    const row = this.rows.get(id);
    return !row ? result : { ...result, details: {
      nativeCodemodeCall: copyJson(row),
      ...(result.details === undefined ? {} : { nativeDetails: result.details }),
    } };
  }

  restore(call: Call, result: NestedToolExecutionResult): void {
    const details = result.details;
    const saved = details && typeof details === 'object' && !Array.isArray(details)
      ? details.nativeCodemodeCall : undefined;
    if (saved && typeof saved === 'object' && !Array.isArray(saved) &&
        typeof saved.id === 'string' && typeof saved.name === 'string' && typeof saved.args === 'string' &&
        (saved.status === 'ok' || saved.status === 'error' || saved.status === 'cancelled')) {
      if (!this.rows.has(call.id) && this.isModel(call.name)) this.modelCount++;
      this.rows.set(call.id, {
        id: saved.id, name: saved.name, args: saved.args, status: saved.status,
        ...(typeof saved.durationMs === 'number' ? { durationMs: saved.durationMs } : {}),
        ...(typeof saved.cost === 'number' ? { cost: saved.cost } : {}),
        ...(typeof saved.error === 'string' ? { error: saved.error } : {}),
      });
    } else {
      this.start(call);
      const row = this.rows.get(call.id)!;
      row.status = result.isError ? 'error' : 'ok';
      if (result.durationMs !== undefined) row.durationMs = result.durationMs;
      if (result.isError) row.error = cut(result.diagnostics.map(item => item.message).join('\n'), 500);
    }
    if (this.isModel(call.name) && result.usage && !this.accounted.has(result.taskId)) {
      this.accounted.add(result.taskId);
      this.usage = this.usage ? combineUsage(this.usage, result.usage) : result.usage;
    }
    this.publish();
  }

  finishTool(id: number, outcome: AgentToolCallOutcome, cancelled: boolean): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.id = outcome.toolCall.id;
    row.status = outcome.isError ? cancelled ? 'cancelled' : 'error' : 'ok';
    if (outcome.isError) row.error = cut(nativeResultText(outcome.result) || `Tool "${row.name}" failed`, 500);
    this.finish(id);
  }

  finishModel(id: number, taskId: TaskId, result: Awaited<ReturnType<CodemodePreparedModelCall['execute']>>): void {
    const row = this.rows.get(id);
    const value = result.structuredOutput;
    if (row) {
      row.status = value.stopReason === 'stop' ? 'ok' : value.stopReason === 'aborted' ? 'cancelled' : 'error';
      if (value.errorMessage) row.error = cut(value.errorMessage, 500);
      if (value.usage) row.cost = value.usage.cost.total;
    }
    if (value.usage && !this.accounted.has(taskId)) {
      this.accounted.add(taskId);
      this.usage = this.usage ? combineUsage(this.usage, value.usage) : value.usage;
    }
    this.finish(id);
  }

  fail(id: number, error: unknown, cancelled: boolean): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = cancelled ? 'cancelled' : 'error';
    row.error = cut(error instanceof Error ? error.message : String(error), 500);
    this.finish(id);
  }

  stop(): void {
    for (const row of this.rows.values()) if (row.status === 'running') row.status = 'cancelled';
  }

  private finish(id: number): void {
    const row = this.rows.get(id);
    if (row) row.durationMs = performance.now() - this.started.get(id)!;
    this.publish();
  }
}

/** Catalog methods must retain the Native registry's receiver and refresh on every use. */
export function nativeCodemodeModels(native: CodemodeModelRuntime, fallback: Models): Models {
  const methods = new Set(['getModelsOfType', 'getAvailableOfType', 'getModelOfType']);
  return new Proxy(fallback, {
    get(target, key) {
      const owner = methods.has(String(key)) ? native : target;
      const value = Reflect.get(owner, key, owner);
      return typeof value === 'function' ? value.bind(owner) : value;
    },
  });
}
