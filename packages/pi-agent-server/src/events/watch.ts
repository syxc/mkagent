/** Collect public synchronous observers before host delivery can await any work. */
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@earendil-works/chord';
import type { Op } from '@earendil-works/chord/delta';
import type { CommitPublication, ConversationId, ConversationView, EntryRecord, Harness, WatchCall } from '@earendil-works/pi-durable';
import { EventTranslator } from './translate.ts';
import type { AgentEvent } from './types.ts';

export type { AgentEvent } from './types.ts';

interface Frame {
  before: ConversationView;
  after: ConversationView;
  entries: readonly EntryRecord[];
  publication?: CommitPublication;
}

/** Read insertions from ops: the same revision can also trim them out of its window. */
function appended(ops: readonly Op[]): EntryRecord[] {
  return ops.flatMap(op => op[0] === 'p' && op[1].length === 1 && op[1][0] === 'entries'
    ? op[4] as unknown as EntryRecord[] : []);
}

function matches(frame: Frame, publication: CommitPublication): boolean {
  let relevant = false;
  for (const change of publication.changes) {
    if (change.type === 'entry' && change.value.conversationId === frame.after.conversation.id) {
      relevant = true;
      if (!frame.entries.some(entry => entry.id === change.value.id)) return false;
    } else if (change.type === 'document' && change.conversationId === frame.after.conversation.id
      && ['pi.live', 'pi.inbox', 'pi.agent', 'pi.usage', 'pi.provider'].includes(change.record.kind)) {
      relevant = true;
      const value = change.kind === 'retire' ? undefined : change.value;
      if (!isDeepStrictEqual(frame.after.docs[change.record.kind], value)) return false;
    }
  }
  return relevant;
}

export async function watchEvents(harness: Harness, conversationId: ConversationId, context: Context) {
  const translator = new EventTranslator();
  let current: ConversationView | undefined;
  let ready = false;
  let stopped = false;
  let scheduled = false;
  let listener: ((events: readonly AgentEvent[]) => void) | undefined;
  const early: WatchCall<ConversationView>[] = [];
  const frames: Frame[] = [];
  const publications: CommitPublication[] = [];
  const batches: AgentEvent[][] = [];
  const flush = () => {
    scheduled = false;
    if (!ready || stopped) return;
    // Stored host publications arrive on a microtask. Associate them with the
    // adopted revision by content, never by callback count: holds may coalesce.
    for (const publication of publications.splice(0)) {
      const frame = frames.find(frame => !frame.publication && matches(frame, publication));
      if (frame) frame.publication = publication;
      else frames.push({ before: current!, after: current!, entries: [], publication });
    }
    for (const frame of frames.splice(0)) {
      const events = translator.translate(frame.before, frame.after, frame.entries, frame.publication);
      if (events.length) batches.push(events);
    }
    if (listener) for (const events of batches.splice(0)) listener(events);
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };
  const record = (call: WatchCall<ConversationView>) => {
    if (call.kind !== 'value') return;
    frames.push({ before: current!, after: call.value, entries: appended(call.ops) });
    current = call.value;
    schedule();
  };
  const commits = harness.observeCommits({
    advance(publication) { publications.push(publication); schedule(); },
    end() {},
  });
  let observation;
  try {
    observation = await harness.observeConversation(conversationId, {
      advance(call) { if (ready) record(call); else early.push(call); },
      end() {},
    }, context);
  } catch (error) {
    stopped = true;
    commits.detach();
    throw error;
  }
  current = observation.value;
  // Publications before attachment are already represented by the initial value.
  const initialPublications = publications.splice(0);
  for (const call of early.splice(0)) record(call);
  publications.push(...initialPublications.filter(publication => frames.some(frame => matches(frame, publication))));
  ready = true;
  schedule();
  return {
    start(next: (events: readonly AgentEvent[]) => void) {
      if (listener) throw new Error('Durable event listener already installed');
      listener = next;
      schedule();
    },
    stop() {
      stopped = true;
      observation.detach();
      commits.detach();
      frames.length = publications.length = batches.length = 0;
    },
  };
}
