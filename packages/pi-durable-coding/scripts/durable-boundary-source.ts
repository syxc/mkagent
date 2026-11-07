/** Minimal source transformations for durable's native coding boundaries. */
import { writeFileSync } from 'node:fs';

export const BOUNDARY_PATCH_FILES = Object.freeze([
  'dist/harness/generation.js', 'dist/harness/generation.d.ts',
  'dist/harness/types.d.ts', 'dist/harness/live.d.ts',
]);

/** Never replace an existing patch; limit read-only checks to the historical scope. */
export function assertBoundaryPatchScope(patch: string | undefined, checking = false): void {
  if (patch === undefined) {
    if (checking) throw new Error('The historical --check requires an existing Git patch.');
    return;
  }
  if (!checking) {
    throw new Error('The historical four-file boundary generator cannot overwrite an existing SDK patch. '
      + 'Use --check only for a four-file boundary patch; preserve the complete SDK patch when rebuilding.');
  }
  let sections = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith('diff --git')) continue;
    const paths = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (!paths || !BOUNDARY_PATCH_FILES.includes(paths[1]!) || !BOUNDARY_PATCH_FILES.includes(paths[2]!)) {
      throw new Error('The historical four-file boundary generator cannot replace the complete SDK patch. '
        + 'Preserve every existing patch section when rebuilding from pristine dependencies.');
    }
    sections++;
  }
  if (!sections) throw new Error('The historical --check requires a Git patch with boundary file sections.');
}

/** A patch created after preflight must also survive, before any SDK output is written. */
export function createBoundaryPatch(path: string, patch: string): void {
  writeFileSync(path, patch, { flag: 'wx' });
}

export const codingTypes = `
type CodingPlan =
  | { kind: "answer"; continuation?: UserInput }
  | { kind: "tools"; tools: TaskId<ToolTaskResult>[] }
  | { kind: "terminate"; last: EntryId }
  | { kind: "failure"; request: Request };
type CodingState = {
  assistant: EntryId;
  results: EntryId[];
  turnIndex: number;
  outcome: "completed" | "error" | "aborted";
  plan: CodingPlan;
  continued?: boolean;
  appliedWrite?: SubmissionId;
};
type CodingCheckpoint = CodingState & (
  | { phase: "codingBoundary" }
  | { phase: "codingSettle"; step: "route" | "before" | "finalize" }
);
type CodingPrepareCheckpoint = {
  phase: "codingPrepare";
  prepare: {
    phase: "prepare"; attempt: number; codingPrepared?: true;
    compacted?: TaskId<CompactionResult>; overflow?: string; threshold?: true;
  };
};
`;

export const codingHook = `
  /** Await native run/turn and input-message handlers before rendering this request's agent and prompt. */
  codingPrepare(
    event: { readonly agentStart: boolean; readonly turnIndex: number; readonly first?: EntryId; readonly after?: EntryId },
    api: HookApi, context: Context,
  ): HookResult<{ readonly entries?: readonly (EntryDraft & { references?: { head?: number; edits?: Record<number, number> } })[] }>;

  /** Await native stream handlers before consuming the next provider event. Closing drains plugin writes. */
  codingStream(
    frame: { readonly type: "event"; readonly event: AssistantMessageEvent }
      | { readonly type: "closed"; readonly aborted: boolean },
    api: HookApi, context: Context,
  ): HookResult<void>;

  /**
   * A committed native coding boundary. The host returns validated entry drafts.
   * Decisions are memoized per task, event and turn; drafts and the next phase
   * commit together. Side effects before the memo commits may repeat on restart.
   */
  codingBoundary(
    boundary: {
      readonly type: "turn_end" | "agent_before_settle";
      readonly assistant: EntryId;
      readonly results: readonly EntryId[];
      readonly turnIndex: number;
      readonly outcome: "completed" | "error" | "aborted";
    },
    api: HookApi, context: Context,
  ): HookResult<{ readonly entries?: readonly (EntryDraft & { references?: { head?: number; edits?: Record<number, number> } })[]; readonly continue?: boolean }>;
`;

export function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error("Durable patch anchor changed: " + before.slice(0, 80));
  return source.replace(before, after);
}

/** Transform only known v1.5.0 functions; leave the no-hook paths intact. */
export function patchGeneration(original: string, batchImplementation: string): string {
  let source = replaceOnce(original, 'version: 2,', 'version: 4,');
  source = replaceOnce(source, 'export type GenerationInput = Record<string, never>;',
    'export type GenerationInput = { codingRequest?: true };');
  source = replaceOnce(source, 'phase: "prepare";\n\t\t\tattempt: number;',
    'phase: "prepare";\n      codingPrepared?: true;\n\t\t\tattempt: number;');
  source = replaceOnce(source, '\t\t\tconst { conversationId } = runtime;\n\t\t\tconst agent = await runtime.agent(context);',
    `      const { conversationId } = runtime;
      const agent = await runtime.agent(context);
      if (!task.state.checkpoint.codingPrepared && agentHooks(agent, GenerationTask.definition.name)
        .some(({ handlers }) => typeof (handlers as Partial<GenerationHooks>).codingPrepare === "function")) {
        await runtime.commit(async () => ({
          status: "running", checkpoint: { phase: "codingPrepare", prepare: task.state.checkpoint },
        }), context);
        return;
      }`);
  source = replaceOnce(source, '\tEntryId,\n\tNextTaskState,', '\tEntryId,\n\tEntryDraft,\n\tNextTaskState,');
  source = replaceOnce(source, '\t  };\n\nexport type GenerationResult', '\t  }\n  | CodingCheckpoint | CodingPrepareCheckpoint;\n\n' + codingTypes + '\nexport type GenerationResult');
  source = replaceOnce(source,
    'if (last?.role !== "user" && last?.role !== "toolResult") return failNothingToAnswer(runtime, context);',
    'if (!task.input.codingRequest && last?.role !== "user" && last?.role !== "toolResult") return failNothingToAnswer(runtime, context);');
  source = replaceOnce(source,
    'if (next === undefined) return finishToolRound(runtime, assistant, tools, context);',
    `if (next === undefined) {
      if (await codingEnabled(runtime, context)) return stageCodingTools(runtime, assistant, tools, context);
      return finishToolRound(runtime, assistant, tools, context);
    }`);
  source = replaceOnce(source, '\t\tfinish: async (task, runtime, context) => {', `
    codingPrepare: async (task, runtime, context) => {
      if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
      return prepareCodingEvents(runtime, task.state.checkpoint.prepare, context);
    },
    codingBoundary: async (task, runtime, context) => {
      if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
      return commitCodingDecision(runtime, task.state.checkpoint, "turn_end", context);
    },
    codingSettle: async (task, runtime, context) => {
      if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
      const state = task.state.checkpoint;
      if (state.step === "before") return commitCodingDecision(runtime, state, "agent_before_settle", context);
      if (state.plan.kind === "tools") {
        const continued = state.continued === true && await codingCanAnswer(runtime, context);
        return finishToolRound(runtime, state.assistant, state.plan.tools, context, { ...state, continued });
      }
      if (state.plan.kind === "failure") {
        if (state.continued && await codingCanAnswer(runtime, context)) {
          return routeCodingAnswer(runtime, state, context);
        }
        const message = (await runtime.entry(AssistantEntry, state.assistant, context))!.model![0] as AssistantMessage;
        return recoverFailure(runtime, state.plan.request, message, context, state);
      }
      return routeCodingAnswer(runtime, state, context);
    },
    finish: async (task, runtime, context) => {`);
  source = replaceOnce(source, '\t// The retry and compaction policies govern the next attempt,', `
  if (await codingEnabled(runtime, context)) {
    const { messages: _messages, ...kept } = request;
    return stageCodingTurn(runtime, message, { kind: "failure", request: kept }, context);
  }
  return recoverFailure(runtime, request, message, context);
}

async function recoverFailure(
  runtime: Runtime, request: Request, message: AssistantMessage, context: Context,
  coding?: Extract<CodingCheckpoint, { phase: "codingSettle" }>,
): Promise<void> {
  const conversationId = runtime.conversationId;
  const { attempt, compacted, model: ref, cutoff } = request;
  // The retry and compaction policies govern the next attempt,`);
  const failureStart = source.indexOf('async function recoverFailure(');
  const failureEnd = source.indexOf('\n/**\n * A final answer;', failureStart);
  if (failureStart < 0 || failureEnd < 0) throw new Error('Durable failure function changed');
  const failure = source.slice(failureStart, failureEnd);
  if (failure.split('await appendAssistant(tx, conversationId, message);').length !== 3) throw new Error('Durable failure writers changed');
  source = source.slice(0, failureStart) + failure.replaceAll(
    'await appendAssistant(tx, conversationId, message);',
    'if (coding === undefined) await appendAssistant(tx, conversationId, message);',
  ) + source.slice(failureEnd);
  source = replaceOnce(source, '\tconst until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;\n\tawait runtime.commit(async (tx): Promise<Next> => {\n\t\t// Read before the first table write; only a failure uses it.',
    `  const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
  if (!retry && coding?.step === "route") {
    await runtime.commit(async () => ({
      status: "running", checkpoint: { ...coding, step: "before" },
    }), context);
    return;
  }
  await runtime.commit(async (tx): Promise<Next> => {
    // Read before the first table write; only a failure uses it.`);
  source = replaceOnce(source, '\tconst afterRun = await asksAfterRun(runtime, context);\n\tconst conversationId = runtime.conversationId;',
    `  if (await codingEnabled(runtime, context)) {
    return stageCodingTurn(runtime, message, { kind: "answer", ...(continuation === undefined ? {} : { continuation }) }, context);
  }
  const afterRun = await asksAfterRun(runtime, context);
  const conversationId = runtime.conversationId;`);
  source = replaceOnce(source,
    '\ttools: readonly TaskId<ToolTaskResult>[],\n\tcontext: Context,\n): Promise<void> {',
    '\ttools: readonly TaskId<ToolTaskResult>[],\n\tcontext: Context,\n  coding?: CodingState,\n): Promise<void> {');
  source = replaceOnce(source, '\tawait runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));',
    '\tif (coding === undefined) await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));');
  source = replaceOnce(source, 'const terminate = slots.length > 0 && ordered.every((control) => control?.terminate === true);',
    'const terminate = coding?.continued !== true && slots.length > 0 && ordered.every((control) => control?.terminate === true);');
  source = replaceOnce(source,
    '\t\tif (added.length > 0) await addTools(tx, conversationId, added);\n\t\tconst live = await tx.doc(LiveDoc, conversationId);',
    `    const live = await tx.doc(LiveDoc, conversationId);
    const turns = live.run?.taskId === runtime.taskId ? live.run.turns : 0;
    const limited = maxTurns !== undefined && turns >= maxTurns;
    const resetQueued = hasQueuedReset(boundary.inbox.items);
    if (coding !== undefined && (terminate || limited || resetQueued)
      && !("step" in coding && coding.step === "finalize")) {
      return {
        status: "running", checkpoint: {
          ...coding, phase: "codingSettle", step: "before", continued: false,
          outcome: terminate ? "completed" : limited ? "error" : "aborted",
          plan: { kind: "tools", tools: [...tools] },
        },
      };
    }
    if (added.length > 0) await addTools(tx, conversationId, added);`);
  source = replaceOnce(source,
    '\t\tconst turns = live.run?.taskId === runtime.taskId ? live.run.turns : 0;\n\t\tconst held = afterRun',
    '\t\tconst held = afterRun');
  source = replaceOnce(source,
    '\t\t\t\thandOver(live, runtime.taskId, await createGeneration(tx, conversationId));',
    '\t\t\t\thandOver(live, runtime.taskId, await createGeneration(tx, conversationId, {}, coding === undefined ? {} : { codingRequest: true }));');
  source = replaceOnce(source, '\ttelemetry: Pick<TaskCreationOptions, "submissionIds"> = {},\n): Promise<TaskId<GenerationResult>> {',
    '\ttelemetry: Pick<TaskCreationOptions, "submissionIds"> = {},\n  input: GenerationInput = {},\n): Promise<TaskId<GenerationResult>> {');
  source = replaceOnce(source, 'return tx.createTask(GenerationTask, {}, { ownership:',
    'return tx.createTask(GenerationTask, input, { ownership:');
  source = replaceOnce(source, '\ttry {\n\t\tconst events = runtime.models.streamSimple(model, { messages: [...messages] }, options);',
    `  const observeCoding = agentHooks(await runtime.agent(context), GenerationTask.definition.name)
    .some(({ handlers }) => typeof (handlers as Partial<GenerationHooks>).codingStream === "function");
  try {
    const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);`);
  source = replaceOnce(source, '\t\tfor await (const event of events) {',
    `    for await (const event of events) {
      if (observeCoding) {
        const copied = copyJson(event, { omitUndefinedProperties: true }) as unknown as typeof event;
        await runtime.hooks.each("codingStream", handler => handler({ type: "event", event: copied }, runtime, context));
      }`);
  source = replaceOnce(source, '\t\tawait inFlight;\n\t}\n}',
    `    await inFlight;
    if (observeCoding) await runtime.hooks.each("codingStream", handler =>
      handler({ type: "closed", aborted: runtime.signal.aborted }, runtime, context));
  }
}`);
  return source + helpers + '\n' + batchImplementation;
}

const helpers = `

/** One preparation per request attempt, including a prompt preparation resumed after compaction. */
async function prepareCodingEvents(runtime: Runtime, checkpoint: CodingPrepareCheckpoint["prepare"], context: Context): Promise<void> {
  const { attempt } = checkpoint;
  const key = "mkagent.coding." + "prepare.v1:" + attempt;
  let prepared = await runtime.memo(key, context);
  if (prepared === undefined) {
    const run = (await runtime.snapshot(LiveDoc, runtime.conversationId, context))?.run;
    const latest = (await runtime.entries({}, 1, undefined, context)).items[0]?.id;
    const batches: CodingEntryDraft[][] = [];
    await runtime.hooks.each("codingPrepare", async handler => {
      const result = await handler({
        agentStart: run?.codingStarted !== true, turnIndex: run?.codingTurn ?? 0,
        ...(run?.first === undefined ? {} : { first: run.first }),
        ...(run?.codingLastMessage === undefined ? {} : { after: run.codingLastMessage }),
      }, runtime, context);
      if (result?.entries) batches.push(copyJson(result.entries, { omitUndefinedProperties: true }) as unknown as CodingEntryDraft[]);
    });
    prepared = await runtime.memo(key, copyJson({ batches, latest }, { omitUndefinedProperties: true }), context);
  }
  const value = prepared as unknown as { batches: CodingEntryDraft[][]; latest?: EntryId };
  await runtime.commit(async tx => {
    const next = { status: "running", checkpoint: { ...checkpoint, codingPrepared: true } } as const;
    const live = await tx.doc(LiveDoc, runtime.conversationId);
    if (live.run?.taskId !== runtime.taskId) return next;
    // The same memo can be revisited after blocking compaction; the commit marker also covers empty hook batches.
    if (live.run.codingPreparation?.taskId === runtime.taskId && live.run.codingPreparation.attempt === attempt) return next;
    for (const batch of value.batches) await appendCodingEntries(tx, runtime.conversationId, batch);
    live.run.codingStarted = true;
    live.run.codingPreparation = { taskId: runtime.taskId, attempt };
    if (value.latest !== undefined) live.run.codingLastMessage = value.latest;
    return next;
  }, context);
}

/** Native boundaries are opt-in; all ordinary durable runs keep their original path. */
async function codingEnabled(runtime: Runtime, context: Context): Promise<boolean> {
  return agentHooks(await runtime.agent(context), GenerationTask.definition.name)
    .some(({ handlers }) => typeof (handlers as Partial<GenerationHooks>).codingBoundary === "function");
}

async function codingCanAnswer(runtime: Runtime, context: Context): Promise<boolean> {
  const view = await runtime.context(runtime.conversationId, context);
  const last = view.messages.findLast(message => message.role !== "system");
  return last?.role === "user" || last?.role === "toolResult";
}

async function stageCodingTurn(
  runtime: Runtime, message: AssistantMessage, plan: CodingPlan, context: Context,
): Promise<void> {
  await runtime.commit(async tx => {
    const live = await tx.doc(LiveDoc, runtime.conversationId);
    const entry = await appendAssistant(tx, runtime.conversationId, message);
    delete live.generation;
    const state: CodingCheckpoint = {
      phase: "codingBoundary", assistant: entry.id, results: [], plan,
      turnIndex: live.run?.codingTurn ?? 0,
      outcome: message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed",
    };
    return { status: "running", checkpoint: state };
  }, context);
}

async function stageCodingTools(
  runtime: Runtime, assistant: EntryId, tools: TaskId<ToolTaskResult>[], context: Context,
): Promise<void> {
  const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);
  const results = live?.tools?.flatMap(slot => slot.entry === undefined ? [] : [slot.entry]) ?? [];
  await runtime.hooks.each("afterTools", handler => handler(assistant, results, runtime, context));
  await runtime.commit(async () => ({
    status: "running",
    checkpoint: {
      phase: "codingBoundary", assistant, results, plan: { kind: "tools", tools },
      turnIndex: live?.run?.codingTurn ?? 0, outcome: "completed",
    },
  }), context);
}

async function commitCodingDecision(
  runtime: Runtime, state: CodingCheckpoint,
  type: "turn_end" | "agent_before_settle", context: Context,
): Promise<void> {
  const key = "mkagent.coding." + type + ".v1:" + state.turnIndex;
  let decision = await runtime.memo(key, context);
  if (decision === undefined) {
    const prepared: { entries: CodingEntryDraft[]; continue: boolean } = { entries: [], continue: false };
    await runtime.hooks.each("codingBoundary", async handler => {
      const asked = await handler({
        type, assistant: state.assistant, results: state.results,
        turnIndex: state.turnIndex, outcome: state.outcome,
      }, runtime, context);
      if (asked === undefined) return;
      // Validate the hook's JSON inside its reporting scope, before merging it.
      const checked = copyJson(asked, { omitUndefinedProperties: true }) as unknown as typeof asked;
      if (checked.entries) {
        const offset = prepared.entries.length;
        for (const entry of checked.entries) {
          const refs = entry.references;
          prepared.entries.push(refs === undefined ? entry : {
            ...entry, references: {
              ...(refs.head === undefined ? {} : { head: refs.head + offset }),
              ...(refs.edits === undefined ? {} : { edits: Object.fromEntries(
                Object.entries(refs.edits).map(([index, target]) => [index, target + offset]),
              ) }),
            },
          });
        }
      }
      if (checked.continue !== undefined) prepared.continue = checked.continue;
    });
    decision = await runtime.memo(key, copyJson(prepared, { omitUndefinedProperties: true }), context);
  }
  // The memo stores precisely this host decision, with JSON-checked drafts.
  const prepared = decision as unknown as { entries: CodingEntryDraft[]; continue: boolean };
  await runtime.commit(async tx => {
    await appendCodingEntries(tx, runtime.conversationId, prepared.entries);
    const live = await tx.doc(LiveDoc, runtime.conversationId);
    if (type === "turn_end" && live.run?.taskId === runtime.taskId) live.run.codingTurn = state.turnIndex + 1;
    return {
      status: "running", checkpoint: {
        ...state, phase: "codingSettle", step: type === "turn_end" ? "route" : "finalize",
        continued: prepared.continue,
      },
    };
  }, context);
}

/** Apply inbox writes before deciding whether this activity can settle. */
async function routeCodingAnswer(
  runtime: Runtime, state: Extract<CodingCheckpoint, { phase: "codingSettle" }>, context: Context,
): Promise<void> {
  const canAnswer = await codingCanAnswer(runtime, context);
  const wants = state.continued === true && canAnswer;
  const afterRun = state.step === "finalize" && await asksAfterRun(runtime, context);
  const conversationId = runtime.conversationId;
  await runtime.commit(async (tx): Promise<Next> => {
    const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
    const last = await tx.latestEntryId(conversationId) ?? state.assistant;
    const live = await tx.doc(LiveDoc, conversationId);
    const hasReset = hasQueuedReset(boundary.inbox.items);
    if (hasReset && state.step === "route") {
      return { status: "running", checkpoint: { ...state, step: "before", continued: false } };
    }
    const continuation = state.plan.kind === "answer" ? state.plan.continuation : undefined;
    const yielding = takesContinuation(continuation, boundary) ? continuation : undefined;
    const queuedUser = boundary.inbox.items.some(item => item.mode === "steer" || item.mode === "followUp");
    const queuedWrite = boundary.inbox.items.findLast(item => item.mode === "write");
    const queuedWrites = queuedWrite !== undefined;
    if (state.continued && !canAnswer && !queuedUser && !queuedWrites && !hasReset && yielding === undefined) {
      runtime.report(new Error("Coding continuation has no answerable context"), { kind: "extension" });
    }
    // afterRun owns the final boundary. In particular, reset inputs cannot be placed into the old run.
    if (afterRun && (hasReset || (!wants && !queuedUser && yielding === undefined && !(state.continued && queuedWrites)))) {
      const held = holdRun(tx, live, runtime, {
        reason: state.plan.kind === "terminate" ? "terminate" : "answer", answer: state.assistant, last,
      });
      if (held !== undefined) return held;
    }
    // A before-settle continuation on new context precedes queued follow-ups.
    const at = state.step === "finalize" && state.continued && (canAnswer || queuedWrites) ? "postTools" : "final";
    const { users, first, reset } = await applyBoundary(tx, boundary, at, runtime.now());
    const completed: Next = {
      status: "terminal", outcome: { status: "completed", result: { entryId: state.assistant } },
    };
    if (!hasReset && (wants || users.length > 0 || yielding !== undefined)) {
      if (yielding !== undefined) {
        await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: yielding, timestamp: runtime.now() }] });
      }
      if (live.run?.taskId === runtime.taskId) {
        live.run.inputs.push(...users);
        if (yielding !== undefined) live.run.turns = 0;
      }
      handOver(live, runtime.taskId, await createGeneration(tx, conversationId, {}, { codingRequest: true }));
      delete live.generation;
      return completed;
    }
    if (!reset && state.continued && !canAnswer && queuedWrites) {
      // Context queries see committed history. Re-evaluate the same decision after the writes land.
      return { status: "running", checkpoint: { ...state, appliedWrite: queuedWrite!.id } };
    }
    if (state.step === "route" && !reset) {
      return { status: "running", checkpoint: { ...state, step: "before", continued: false } };
    }
    endRun(tx, live, runtime.taskId, { status: "done", answer: state.assistant });
    if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
    return completed;
  }, context);
}
`;
