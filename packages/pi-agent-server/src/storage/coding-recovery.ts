/** Adopt a fenced coding generation without admitting its original inputs a second time. */
import { copyJson, type JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { defineDoc, type Conversation, type EntryId, type Harness, type SubmissionId, type Tx } from '@earendil-works/pi-durable';
import type { CodingSessionCompletion, DurableLoopBinding, LoopInput, NativeSessionJournal } from '@mkagent/coding-runtime/durable';
import { convertToLlm, type AgentSession } from '@mkagent/coding-runtime/native';
import { adoptLegacyCodingWork, type LegacyCodingRecovery } from './coding-migration.ts';

type Admission = { id: SubmissionId; status: 'queued' | 'placed' | 'done'; entry?: EntryId; message?: UserMessage };
const Recovery = defineDoc<{
  owner: number; root: number | null; admissions: JsonValue[];
}>({
  kind: 'mkagent.coding.adopted-inputs', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ owner: 0, root: null, admissions: [] }),
});

export class LegacyCodingAdoption {
  private readonly queued = new Set<SubmissionId>();
  private readonly appended = new Map<SubmissionId, string>();
  private active = false;
  private settled?: CodingSessionCompletion;
  private adopting?: Promise<void>;
  private readonly stop: () => void;

  constructor(
    private readonly harness: Harness, private readonly conversation: Conversation,
    private readonly session: AgentSession, private readonly journal: NativeSessionJournal,
    private readonly durable: DurableLoopBinding,
  ) {
    this.stop = journal.observeMessages({
      appended: (message, id) => {
        const tag = journal.messageTag(message);
        const prefix = `legacy-input:${conversation.id}:`;
        const submission = tag?.startsWith(prefix) ? Number(tag.slice(prefix.length)) as SubmissionId : undefined;
        if (submission !== undefined && this.queued.has(submission)) this.appended.set(submission, id);
      },
      committed: () => {},
      discarded: nativeId => {
        for (const [id, value] of this.appended) if (value === nativeId) this.appended.delete(id);
      },
    });
  }

  async restore(): Promise<void> {
    const saved = await this.harness.snapshot(Recovery, this.conversation.id, BACKGROUND_CONTEXT);
    this.active = saved?.owner === this.conversation.id && saved.admissions.length > 0;
    this.queued.clear();
    if (this.active) for (const admission of saved!.admissions as unknown as Admission[])
      if (admission.status === 'queued') this.queued.add(admission.id);
  }

  /** All mutation here belongs to the same receipt as the marker acknowledgement and successor root. */
  adopt(): Promise<void> {
    return this.adopting ??= this.adoptOnce().finally(() => { this.adopting = undefined; });
  }

  private async adoptOnce(): Promise<void> {
    // Startup owns this session until adoption returns. A rejected receipt must restore its queues.
    const before = structuredClone(this.session.exportDurableState());
    const commit = async (tx: Tx) => {
      const receipt = await adoptLegacyCodingWork(tx, this.conversation.id, async recovery => {
        const admissions: Admission[] = recovery.submissions.map(submission => ({
          id: submission.id, status: submission.status === 'queued' ? 'queued' : 'placed',
          entry: submission.entry,
        }));
        const state = structuredClone(before);
        const now = Date.now();
        recovery.queued.forEach((item, index) => {
          if (item.mode !== 'steer' && item.mode !== 'followUp') throw new Error('Unsupported fenced native queue');
          const message: UserMessage = { role: 'user', content: item.content, timestamp: now + index };
          const admission = admissions.find(value => value.id === item.id)!;
          admission.message = message;
          const text = typeof item.content === 'string' ? item.content :
            item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
          if (item.mode === 'steer') {
            state.queues.steering.push(message);
            state.steering.push(text);
          } else {
            state.queues.followUp.push(message);
            state.followUp.push(text);
          }
          this.journal.tagMessage(message, `legacy-input:${this.conversation.id}:${item.id}`);
        });
        await this.durable.commitQueuedInputs(tx, {
          ...state.queues, nextTurn: state.nextTurn, pendingCustom: state.pendingCustom,
          steeringText: state.steering, followUpText: state.followUp,
        });
        const run = object(recovery.live.run);
        state.turnIndex = typeof run?.codingTurn === 'number' ? run.codingTurn : 0;
        let prepared = this.prepare(recovery);
        if (!prepared && recovery.queued.length) {
          const first = recovery.queued[0]!;
          const admission = admissions.find(value => value.id === first.id)!;
          const message = admission.message!;
          const kind = first.mode === 'steer' ? 'steering' : 'followUp';
          const index = state.queues[kind].indexOf(message);
          state.queues[kind].splice(index, 1);
          (kind === 'steering' ? state.steering : state.followUp).splice(index, 1);
          const model = this.session.model;
          if (!model) throw new Error('Legacy queued recovery needs a configured model');
          prepared = {
            messages: this.journal.manager.buildSessionContext().messages, prompts: [], tools: [],
            model: { provider: model.provider, modelId: model.id },
            reasoning: this.session.thinkingLevel === 'off' ? undefined : this.session.thinkingLevel,
            resume: { phase: 'initialize', prepareAgentStart: {
              content: message.content, placed: false, tag: this.journal.messageTag(message),
            } },
          };
        }
        if (prepared?.resume?.lastTurn) {
          state.lastAssistant = prepared.resume.lastTurn.message;
          const checkpoint = recovery.continuation!.checkpoint;
          if (checkpoint.phase === 'tools') state.lastAssistantEntry = this.journal.nativeIds(checkpoint.assistant)[0];
        }
        state.lastOutcome = 'completed';
        this.session.restoreDurableState(state);
        const ledger = await tx.doc(Recovery, this.conversation.id);
        ledger.owner = this.conversation.id;
        ledger.admissions = copyJson(admissions, { omitUndefinedProperties: true }) as JsonValue[];
        const root = prepared ? await this.durable.admitSession(tx, { operation: 'prepared', prepared })
          : recovery.queued.length ? await this.durable.admitSession(tx, { operation: 'continue' }) : null;
        ledger.root = root;
        return root;
      });
      await this.durable.commitSession(tx);
      return receipt;
    };
    try {
      await this.journal.phase(() => this.conversation.commit(commit, BACKGROUND_CONTEXT));
    } catch (error) {
      this.session.restoreDurableState(before);
      throw error;
    }
    await this.restore();
  }

  onSettled(completion: CodingSessionCompletion): void {
    if (!this.active) return;
    this.settled = completion;
    this.session.agent.state.messages = this.journal.manager.buildSessionContext().messages;
  }

  onStart(): void { this.settled = undefined; }

  async commit(tx: Tx): Promise<void> {
    if (!this.active) return;
    const ledger = await tx.doc(Recovery, this.conversation.id);
    if (ledger.owner !== this.conversation.id) return;
    const admissions = ledger.admissions as unknown as Admission[];
    for (const admission of admissions) {
      if (admission.status !== 'queued') continue;
      const nativeId = this.appended.get(admission.id);
      const entry = nativeId && await this.journal.durableIdIn(tx, nativeId);
      if (entry) {
        tx.placeSubmission(admission.id, entry);
        admission.status = 'placed';
        admission.entry = entry;
      }
    }
    if (!this.settled) return;
    const branch = this.journal.manager.getBranch();
    const positions = new Map<EntryId, number>();
    for (const [index, entry] of branch.entries()) {
      const id = await this.journal.durableIdIn(tx, entry.id);
      if (id) positions.set(id, index);
    }
    const answer = [...branch].reverse().find(entry =>
      entry.type === 'message' && entry.message.role === 'assistant');
    const message = answer?.type === 'message' && answer.message.role === 'assistant' ? answer.message : undefined;
    const id = answer && await this.journal.durableIdIn(tx, answer.id);
    const successful = this.settled.status === 'completed' && id && message?.stopReason !== 'error' && message?.stopReason !== 'aborted';
    for (const admission of admissions) if (admission.status === 'placed') {
      const inputPosition = admission.entry && positions.get(admission.entry);
      const followsInput = inputPosition !== undefined && id && (positions.get(id) ?? -1) > inputPosition;
      tx.settleSubmission(admission.id, successful && followsInput
        ? { status: 'done', answer: id }
        : { status: 'unanswered',
          reason: this.settled.status === 'aborted' ? 'aborted'
            : this.settled.status === 'failed' ? 'native-generation-failed' : 'native-answer-missing',
          detail: this.settled.status === 'failed' ? copyJson(this.settled) : undefined });
      admission.status = 'done';
    }
  }

  close(): void { this.stop(); }

  private prepare(recovery: LegacyCodingRecovery): LoopInput | undefined {
    const checkpoint = recovery.continuation?.checkpoint;
    if (!checkpoint) return;
    const model = this.session.model;
    if (!model) throw new Error('Legacy coding recovery needs a configured model');
    const projection = this.journal.manager.buildSessionProjection();
    const context = checkpoint.phase === 'request' ? projection.entries.filter(entry =>
      (this.journal.durableId(entry.sourceEntry.id) ?? Infinity) <= checkpoint.cutoff).flatMap(entry => entry.messages)
      : projection.messages;
    const run = object(recovery.live.run);
    const first = typeof run?.first === 'number' ? run.first : 0;
    const newMessages = projection.entries.filter(entry =>
      (this.journal.durableId(entry.sourceEntry.id) ?? -1) >= first).flatMap(entry => entry.messages);
    const resume: NonNullable<LoopInput['resume']> = {
      phase: checkpoint.phase === 'request' ? 'request' : checkpoint.phase === 'tools' ? 'finish' : 'prepare',
      newMessages,
    };
    if (checkpoint.phase === 'prepare' && !checkpoint.codingPrepared && run?.codingStarted !== true) {
      const current = projection.entries.find(entry => this.journal.durableId(entry.sourceEntry.id) === first)
        ?.messages.find((message): message is UserMessage => message.role === 'user');
      if (!current) throw new Error('Unprepared legacy run has no admitted starting input');
      resume.prepareAgentStart = { content: current.content, placed: true };
    }
    if (checkpoint.phase === 'request') resume.streamOptions = checkpoint.streamOptions;
    if (checkpoint.phase === 'retry') resume.notBefore = checkpoint.until;
    if (checkpoint.phase === 'tools') {
      const assistant = projection.entries.find(entry => this.journal.durableId(entry.sourceEntry.id) === checkpoint.assistant)
        ?.messages.find((message): message is AssistantMessage => message.role === 'assistant');
      if (!assistant) throw new Error('Fenced tool round has no native assistant');
      const toolResults = projection.messages.filter((message): message is ToolResultMessage =>
        message.role === 'toolResult' && assistant.content.some(part =>
          part.type === 'toolCall' && part.id === message.toolCallId));
      resume.lastTurn = { message: assistant, toolResults };
    }
    return {
      messages: context, prompts: [], tools: getCurrentTools(convertToLlm(context)).map(tool => tool.name),
      model: checkpoint.phase === 'request' ? checkpoint.model : { provider: model.provider, modelId: model.id },
      reasoning: checkpoint.phase === 'request' ? checkpoint.thinkingLevel === 'off' ? undefined : checkpoint.thinkingLevel
        : this.session.thinkingLevel === 'off' ? undefined : this.session.thinkingLevel,
      resume,
    };
  }
}

function object(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
