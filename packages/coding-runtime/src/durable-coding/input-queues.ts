/** A queue acknowledgement survives even before the active run's next checkpoint. */
import { copyJson, type JsonValue } from '@earendil-works/chord';
import { defineDoc, type ConversationId, type Harness, type TaskRecord, type Tx } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { AgentMessage } from '../agent-runtime.ts';
import type { NativeSessionJournal } from './session-journal.ts';

export interface QueuedInput {
  tag: string;
  kind: 'steering' | 'followUp' | 'nextTurn' | 'pendingCustom';
  message: AgentMessage;
  text?: string;
}
export interface InputQueueSnapshot {
  steering: AgentMessage[];
  followUp: AgentMessage[];
  nextTurn: AgentMessage[];
  pendingCustom: AgentMessage[];
  steeringText: string[];
  followUpText: string[];
}
const Queues = defineDoc<{ pending: JsonValue[]; cancelled?: string[] }>({
  kind: 'pi.coding.accepted-inputs', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ pending: [] }),
});

export class NativeInputQueues {
  private restoreInputs?: (inputs: QueuedInput[], cancelled: string[]) => void;
  private readonly cancelled = new Set<string>();

  constructor(private readonly journal: NativeSessionJournal) {}

  bind(restore: (inputs: QueuedInput[], cancelled: string[]) => void): void { this.restoreInputs = restore; }

  discard(messages: AgentMessage[]): void {
    for (const message of messages) {
      const tag = this.journal.messageTag(message);
      if (tag) this.cancelled.add(tag);
    }
  }

  capture(snapshot: InputQueueSnapshot, identify: (message: AgentMessage) => void): QueuedInput[] {
    const inputs: QueuedInput[] = [];
    for (const kind of ['steering', 'followUp', 'nextTurn', 'pendingCustom'] as const) snapshot[kind].forEach((message, index) => {
      identify(message);
      const text = kind === 'steering' || kind === 'followUp'
        ? snapshot[kind === 'steering' ? 'steeringText' : 'followUpText'][index] : undefined;
      inputs.push({ tag: this.journal.messageTag(message)!, kind, message, ...(text === undefined ? {} : { text }) });
    });
    // Copy before the first await, while the synchronous queue operation still owns these objects.
    return copyJson(inputs, { omitUndefinedProperties: true }) as unknown as QueuedInput[];
  }

  async accept(tx: Tx, conversation: ConversationId, inputs: QueuedInput[]): Promise<void> {
    const state = await tx.doc(Queues, conversation);
    const known = new Set((state.pending as unknown as QueuedInput[]).map(input => input.tag));
    for (const input of inputs) if (!known.has(input.tag) && !await this.journal.hasMessageTagIn(tx, input.tag)) {
      state.pending.push(copyJson(input, { omitUndefinedProperties: true }));
      known.add(input.tag);
    }
  }

  async commit(tx: Tx, conversation: ConversationId, fullSnapshot = false): Promise<void> {
    const state = await tx.doc(Queues, conversation);
    const kept: JsonValue[] = [];
    const cancelled = new Set(fullSnapshot ? [] : state.cancelled ?? []);
    for (const input of state.pending as unknown as QueuedInput[]) {
      if (this.cancelled.has(input.tag)) {
        if (!fullSnapshot) cancelled.add(input.tag);
      } else if (!await this.journal.hasMessageTagIn(tx, input.tag))
        kept.push(copyJson(input, { omitUndefinedProperties: true }));
    }
    if (kept.length !== state.pending.length) state.pending = kept;
    if (state.cancelled?.length || cancelled.size) state.cancelled = [...cancelled];
  }

  async restore(
    harness: Harness, conversation: ConversationId, context: Context,
    tasks: ReadonlyArray<{ record: TaskRecord<JsonValue, JsonValue, JsonValue> }>,
  ): Promise<void> {
    const state = await harness.snapshot(Queues, conversation, context);
    if (!state) return;
    const claimed = new Set<string>();
    for (const { record } of tasks) {
      if (record.conversationId !== conversation || 'outcome' in record.state) continue;
      if (record.kind === 'pi.coding.run') {
        for (const value of [record.input, 'checkpoint' in record.state ? record.state.checkpoint : undefined]) {
          const references = object(object(value)?.messageReferences);
          for (const reference of Object.values(references ?? {})) {
            const tag = object(reference)?.tag;
            if (typeof tag === 'string') claimed.add(tag);
          }
        }
      } else if (record.kind === 'pi.coding.session') {
        const tag = object(object(object(object(record.input)?.prepared)?.resume)?.prepareAgentStart)?.tag;
        if (typeof tag === 'string') claimed.add(tag);
      }
    }
    const cancelled = new Set([...state.cancelled ?? [], ...this.cancelled]);
    this.restoreInputs?.((state.pending as unknown as QueuedInput[])
      .filter(input => !claimed.has(input.tag) && !cancelled.has(input.tag)), [...cancelled]);
  }
}

function object(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
