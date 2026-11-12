/** Preserve native message aliases across JSON checkpoints with stable session entry references. */
import type { AgentMessage } from '../agent-runtime.ts';
import type { LoopCheckpoint } from './run-task.ts';
import type { NativeSessionJournal } from './session-journal.ts';

type Reference = { entry?: string; index?: number; tag?: string };
export type MessageReferences = Record<string, Reference>;

export class NativeMessageIdentities {
  private readonly ids = new WeakMap<object, Reference>();

  constructor(
    private readonly journal: NativeSessionJournal,
    private readonly restoreMessages: (messages: AgentMessage[]) => void,
  ) {}

  appended(message: AgentMessage): void {
    const leaf = this.journal.manager.getLeafId();
    if (leaf) this.ids.set(message, { entry: leaf, index: 0 });
  }

  capture(state: LoopCheckpoint): MessageReferences {
    const projection = this.journal.manager.buildSessionProjection();
    const entries = projection.entries.flatMap(entry =>
      entry.messages.map((message, index) => ({ message, reference: { entry: entry.sourceEntry.id, index } })));
    // The projection has native entry identity even when context edits replaced its message objects.
    if (entries.length === state.messages.length) for (const [index, candidate] of entries.entries()) {
      const message = state.messages[index]!;
      if (same(message, candidate.message)) this.ids.set(message, candidate.reference);
    }
    const references: MessageReferences = {};
    visit(state, (path, message) => {
      const tag = this.journal.messageTag(message);
      const native = this.ids.get(message);
      const reference = tag ? { ...native, tag } : native;
      if (reference) references[path] = reference;
      return message;
    });
    return references;
  }

  restore(state: LoopCheckpoint): void {
    const references = state.messageReferences ?? {};
    const instances = new Map<string, AgentMessage>();
    visit(state, (path, message) => {
      const reference = references[path];
      if (!reference) return message;
      // Context edits can give the same entry a different projection; keep those variants distinct.
      const key = `${reference.entry ?? reference.tag}\0${reference.index}\0${JSON.stringify(message)}`;
      const canonical = instances.get(key) ?? message;
      instances.set(key, canonical);
      this.ids.set(canonical, reference);
      if (reference.tag) this.journal.tagMessage(canonical, reference.tag);
      return canonical;
    });
    // Native boundary and context-only entries can update Agent.state after the loop has
    // captured its context. Restore the authoritative history while retaining known aliases.
    const byEntry = new Map<string, AgentMessage>();
    for (const message of state.messages) {
      const reference = this.ids.get(message);
      if (reference?.entry) byEntry.set(`${reference.entry}\0${reference.index}\0${JSON.stringify(message)}`, message);
    }
    const projection = this.journal.manager.buildSessionProjection();
    this.restoreMessages(projection.entries.flatMap(entry => entry.messages.map((message, index) =>
      byEntry.get(`${entry.sourceEntry.id}\0${index}\0${JSON.stringify(message)}`) ?? message)));
  }
}

function same(a: AgentMessage, b: AgentMessage): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function visit(state: LoopCheckpoint, message: (path: string, value: AgentMessage) => AgentMessage): void {
  state.messages = state.messages.map((value, index) => message(`messages.${index}`, value));
  state.prompts = state.prompts.map((value, index) => message(`prompts.${index}`, value));
  state.newMessages = state.newMessages.map((value, index) => message(`newMessages.${index}`, value));
  state.pending = state.pending.map((value, index) => message(`pending.${index}`, value));
  if (state.message) state.message = message('message', state.message) as typeof state.message;
  state.toolResults = state.toolResults.map((value, index) => message(`toolResults.${index}`, value) as typeof value);
  if (state.lastTurn) {
    state.lastTurn.message = message('lastTurn.message', state.lastTurn.message) as typeof state.lastTurn.message;
    state.lastTurn.toolResults = state.lastTurn.toolResults.map((value, index) =>
      message(`lastTurn.toolResults.${index}`, value) as typeof value);
  }
}
