/**
 * Adapted from pi-durable 1.4.0 harness/events.js (MIT, see NOTICE).
 * Progress comes from every adopted view; table records and nested results come
 * from stored publications. A later persistence of held progress never replays it.
 */
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  CommitPublication, ConversationView, EntryRecord, LiveState,
  NestedCallState, NestedToolExecutionResult, NestedToolSlot, TaskId, TaskRecord,
  ToolSlot, ToolTaskCheckpoint,
} from '@earendil-works/pi-durable';
import type { AgentEvent, MessageChange } from './types.ts';

export const liveOf = (view: ConversationView): LiveState => (view.docs['pi.live'] ?? {}) as LiveState;

function callOf(slot: ToolSlot | NestedToolSlot) {
  return {
    toolCallId: slot.callId,
    toolName: slot.name,
    ...(slot.taskId === undefined ? {} : { taskId: slot.taskId }),
    ...('parentCallId' in slot ? { parentToolCallId: slot.parentCallId, parentTaskId: slot.parentTaskId } : {}),
  };
}

/** Only text and thinking deltas cross the host adapter boundary. */
function messageChanges(before: AssistantMessage, after: AssistantMessage): MessageChange[] {
  const changes: MessageChange[] = [];
  after.content.forEach((block, contentIndex) => {
    const previous = before.content[contentIndex];
    const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined;
    const old = previous?.type === 'text' ? previous.text : previous?.type === 'thinking' ? previous.thinking : '';
    if (text === undefined || text === old) return;
    // Replacements travel in the full message; the host's delta channel can only append.
    if (!text.startsWith(old)) return;
    changes.push({
      type: block.type === 'text' ? 'text_delta' : 'thinking_delta',
      contentIndex, delta: text.slice(old.length),
    });
  });
  return changes;
}

export class EventTranslator {
  private readonly held = new Set<TaskId>();
  private readonly tasks = new Map<TaskId, TaskRecord<unknown, unknown, unknown>>();
  private readonly startedTools = new Set<TaskId>();

  translate(before: ConversationView, after: ConversationView, entries: readonly EntryRecord[], publication?: CommitPublication): AgentEvent[] {
    const events: AgentEvent[] = [];
    const changedTasks: TaskRecord<unknown, unknown, unknown>[] = [];
    const submissions = [];
    const nestedResults = new Map<TaskId, NestedToolExecutionResult>();
    for (const change of publication?.changes ?? []) {
      if (change.type === 'document' && change.kind === 'change'
        && change.record.kind === 'pi.tool.nested-call' && change.conversationId === after.conversation.id) {
        const state = change.value as NestedCallState;
        if (state.taskId !== undefined && state.result !== undefined) nestedResults.set(state.taskId, state.result);
      } else if (change.type === 'task' && change.value.conversationId === after.conversation.id) {
        this.tasks.set(change.value.id, change.value);
        changedTasks.push(change.value);
      } else if (change.type === 'submission' && change.value.conversationId === after.conversation.id) {
        submissions.push(change.value);
      }
    }
    const was = liveOf(before);
    const now = liveOf(after);
    const slotsBefore = new Map((was.tools ?? []).map(slot => [slot.callId, slot]));
    const slots = now.tools ?? [];
    const nestedBefore = new Map((was.nestedTools ?? []).map(slot => [slot.taskId, slot]));
    const nested = now.nestedTools ?? [];
    for (const slot of [...slots, ...nested]) {
      if (slot.status !== 'running') continue;
      if ('parentCallId' in slot) {
        if (nestedBefore.get(slot.taskId)?.status !== 'running') {
          events.push({ type: 'tool_execution_start', ...callOf(slot), args: slot.arguments });
        }
        continue;
      }
      if (slot.taskId === undefined || this.startedTools.has(slot.taskId)) continue;
      const state = slot.taskId === undefined ? undefined : this.tasks.get(slot.taskId)?.state;
      const checkpoint = state && 'checkpoint' in state ? state.checkpoint as ToolTaskCheckpoint : undefined;
      // 1.5 publishes running progress before the durable, repaired execution arguments.
      if (checkpoint?.phase !== 'execute') continue;
      this.startedTools.add(slot.taskId);
      events.push({ type: 'tool_execution_start', ...callOf(slot), args: checkpoint.arguments });
    }
    const partialBefore = was.generation?.message;
    const partial = now.generation?.message;
    if (partial !== undefined && partialBefore === undefined) events.push({ type: 'message_start', message: partial });
    else if (partial !== undefined && partial !== partialBefore) {
      events.push({ type: 'message_update', message: partial, usage: partial.usage, changes: messageChanges(partialBefore!, partial) });
    }
    for (const slot of [...slots, ...nested]) {
      const previous = 'parentCallId' in slot ? nestedBefore.get(slot.taskId) : slotsBefore.get(slot.callId);
      if (slot.status === 'running' && previous?.status === 'running' && slot.output !== previous.output) {
        events.push({ type: 'tool_execution_update', ...callOf(slot), output: { set: slot.output ?? '' } });
      }
    }
    const generation = now.generation;
    const generationBefore = was.generation;
    if (generation?.retry && !generationBefore?.retry) {
      events.push({ type: 'auto_retry_start', attempt: generation.attempt, at: generation.retry.at, errorMessage: generation.retry.error });
    }
    if (generationBefore?.retry && !generation?.retry) events.push({ type: 'auto_retry_end', attempt: generationBefore.attempt });

    const toolEnds: Extract<AgentEvent, { type: 'tool_execution_end' }>[] = [];
    const endTool = (slot: ToolSlot, entryId?: number) => {
      const entry = entries.find(candidate => candidate.id === entryId);
      toolEnds.push({ type: 'tool_execution_end', ...callOf(slot), ...(entry ? { entry } : {}) });
    };
    for (const previous of slotsBefore.values()) {
      if (previous.status === 'done') continue;
      const slot = slots.find(candidate => candidate.callId === previous.callId);
      if (slot?.status === 'done') endTool(slot, slot.entry);
      else if (!slot) endTool(previous, entries.find(entry => {
        const message = entry.model?.[0];
        return message?.role === 'toolResult' && message.toolCallId === previous.callId;
      })?.id);
    }
    for (const slot of slots) if (slot.status === 'done' && !slotsBefore.has(slot.callId)) endTool(slot, slot.entry);
    const endNested = (slot: NestedToolSlot) => {
      const result = nestedResults.get(slot.taskId);
      events.push({ type: 'tool_execution_end', ...callOf(slot), ...(result ? { result } : {}) });
    };
    const nestedNow = new Map(nested.map(slot => [slot.taskId, slot]));
    for (const previous of [...nestedBefore.values()].reverse()) {
      if (previous.status === 'done') continue;
      const slot = nestedNow.get(previous.taskId);
      if (!slot || slot.status === 'done') endNested(slot ?? previous);
    }
    for (const slot of [...nested].reverse()) if (slot.status === 'done' && !nestedBefore.has(slot.taskId)) endNested(slot);

    let assistantAppended = false;
    for (const entry of entries) {
      events.push(...toolEnds.filter(end => end.entry === entry));
      const message = entry.model?.[0];
      if (!message) {
        events.push({ type: 'entry_appended', entry });
        continue;
      }
      const streamed = message.role === 'assistant' && partialBefore !== undefined && !assistantAppended;
      if (message.role === 'assistant') assistantAppended = true;
      if (!streamed) events.push({ type: 'message_start', message });
      events.push({ type: 'message_end', entry });
    }
    events.push(...toolEnds.filter(end => !end.entry));
    for (const status of was.compactions ?? []) {
      if (!(now.compactions ?? []).some(next => next.taskId === status.taskId)) {
        const error = now.compactionFailure?.taskId === status.taskId ? now.compactionFailure.error : undefined;
        events.push({ type: 'compaction_end', taskId: status.taskId, reason: status.trigger, ...(error ? { error } : {}) });
      }
    }
    let turnEnded = false;
    for (const task of changedTasks) {
      if (task.kind !== 'pi.generation') continue;
      if (task.state.status === 'completing' && !this.held.has(task.id)) {
        this.held.add(task.id);
        turnEnded = true;
      } else if (task.state.status === 'terminal' && !this.held.delete(task.id)) turnEnded = true;
    }
    if (turnEnded) events.push({ type: 'turn_end' });
    // An answered run remains busy during afterRun tasks, even though its inputs are now empty.
    const runChanged = !was.run || !now.run
      ? was.run !== now.run
      : now.run.inputs.length > 0 && now.run.inputs[0] !== was.run.inputs[0];
    if (was.run && runChanged) events.push({ type: 'run_end', inputs: was.run.inputs });
    for (const record of submissions.sort((a, b) => a.id - b.id)) events.push({ type: 'submission', record });
    for (const status of now.compactions ?? []) {
      if (!(was.compactions ?? []).some(previous => previous.taskId === status.taskId)) {
        events.push({ type: 'compaction_start', taskId: status.taskId, reason: status.trigger, blocking: status.blocking });
      }
    }
    if (now.run && runChanged) events.push({ type: 'run_start', inputs: now.run.inputs });
    if (now.run && now.run.taskId !== was.run?.taskId && this.tasks.get(now.run.taskId)?.kind === 'pi.generation') {
      events.push({ type: 'turn_start' });
    }
    for (const task of changedTasks) if (task.state.status === 'terminal') {
      this.tasks.delete(task.id);
      this.startedTools.delete(task.id);
    }
    return events;
  }
}
