/** Preserve durable context selection while Pi supplies synchronous entry previews. */
import type { Message } from '@earendil-works/pi-ai';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { CodingEntry } from './session-view.ts';
import { convertToLlm } from './upstream/core/messages.js';
import { contribute, findBaseline, leadWithSystem, orderToolResults } from './upstream/durable/context.js';

interface ProjectedEntry { sourceEntry: CodingEntry; messages: unknown[] }

/** Select the newest head and retained entries without treating every head as a reset. */
export function buildDurableContextEntries(path: CodingEntry[]): CodingEntry[] {
  let marker: CodingEntry | undefined;
  for (const entry of path) if (entry.type === 'compaction' || entry.durableHead !== undefined) marker = entry;
  if (!marker) return path;
  if (marker.durableHead !== undefined) {
    const head = Number(marker.durableHead);
    const order = Number(marker.durableEntryOrder);
    const checkpoint = path.filter(entry => entry.durableEntryOrder === order);
    return [...checkpoint, ...path.filter(entry =>
      entry.durableHead === undefined && entry.type !== 'compaction'
      && (entry.durableEntryOrder === undefined || Number(entry.durableEntryOrder) >= head)
      && entry.durableEntryOrder !== order)];
  }
  const index = path.indexOf(marker);
  const kept = path.findIndex(entry => entry.id === marker.firstKeptEntryId);
  return [marker, ...path.slice(kept < 0 || kept >= index ? index + 1 : kept)
    .filter(entry => entry !== marker && entry.type !== 'compaction' && entry.durableHead === undefined)];
}

/** Apply the upstream durable model rules while retaining native custom message objects. */
export function finalizeDurableProjection(
  entries: ProjectedEntry[], path: CodingEntry[],
): unknown[] {
  if (!path.some(entry => entry.durableEntryOrder !== undefined)) return entries.flatMap(entry => entry.messages);
  const ordered = orderContributions(entries);
  entries.splice(0, entries.length, ...ordered);
  const native = new WeakMap<object, unknown>();
  const messages: Message[] = [];
  for (const entry of entries) {
    const kept: unknown[] = [];
    for (const message of entry.messages) {
      const converted: Message[] = convertToLlm([message]);
      const visible: Message[] = contribute({ model: converted }, undefined);
      if (!visible.length) continue;
      kept.push(message);
      for (const llm of visible) {
        messages.push(llm);
        native.set(llm, message);
      }
    }
    entry.messages = kept;
  }
  const records = path.flatMap(entry => entry.durableContext ? [entry.durableContext as EntryRecord] : []);
  let head: EntryRecord | undefined;
  for (const record of records) if (record.head !== undefined) head = record;
  const baseline = findBaseline(head, records);
  return leadWithSystem(orderToolResults(messages), baseline).map((message: Message) => native.get(message) ?? message);
}

/** A replacement may interleave several messages owned by the same native child entry. */
function orderContributions(entries: ProjectedEntry[]): ProjectedEntry[] {
  const edits = new Map(entries.filter(entry => entry.sourceEntry.type === 'context_edit')
    .map(entry => [entry.sourceEntry.targetId, entry.sourceEntry]));
  const result: ProjectedEntry[] = [];
  for (let index = 0; index < entries.length;) {
    const group: Array<ProjectedEntry & { order: number }> = [];
    const first = entries[index]!;
    if (first.sourceEntry.durableEntryOrder === undefined) {
      result.push(first);
      index++;
      continue;
    }
    let position = 0;
    do {
      const entry = entries[index++]!;
      const source = entry.sourceEntry;
      const edit = edits.get(source.id);
      const newer = edit && (edit.durableEntryOrder === undefined
        || Number(edit.durableEntryOrder) > Number(source.durableModelOrder));
      const order = (newer ? source.durableBaseOrder : source.durableMessageOrder) as number[] | undefined;
      if (!entry.messages.length) group.push({ ...entry, order: Infinity });
      for (const [offset, message] of entry.messages.entries()) {
        group.push({ sourceEntry: source, messages: [message], order: order?.[offset] ?? position++ });
      }
    } while (index < entries.length
      && entries[index]!.sourceEntry.durableEntryOrder === first.sourceEntry.durableEntryOrder);
    result.push(...group.sort((left, right) => left.order - right.order).map(({ order: _, ...entry }) => entry));
  }
  return result;
}
