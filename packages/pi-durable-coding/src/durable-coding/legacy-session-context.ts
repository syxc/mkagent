/** Preserve durable full-message edits and head prefixes through the native session view. */
import type { AgentMessage } from '../agent-runtime.ts';
import {
  projectContextEntry, type CustomEntry, type SessionEntry, type SessionManager,
} from '../pi/core/session-manager.ts';

export const LEGACY_HEAD = 'mkagent.durable.head.v1';
export const LEGACY_EDIT = 'mkagent.durable.edit.v1';
export type LegacyHead = CustomEntry<{ firstKeptEntryId: string; messages: AgentMessage[] }>;
export type LegacyEdit = CustomEntry<{ targets: string[]; messages: AgentMessage[] }>;

export function legacyHead(entry: SessionEntry): entry is LegacyHead {
  return entry.type === 'custom' && entry.customType === LEGACY_HEAD;
}

function legacyEdit(entry: SessionEntry): entry is LegacyEdit {
  return entry.type === 'custom' && entry.customType === LEGACY_EDIT;
}

export function contextBoundary(entry: SessionEntry): boolean {
  return entry.type === 'compaction' || legacyHead(entry);
}

/** The override is local to the durable journal; ordinary native sessions retain their upstream projection. */
export function installLegacyProjection(manager: SessionManager): SessionManager {
  const nativeProjection = manager.buildSessionProjection.bind(manager);
  manager.buildSessionProjection = () => {
    const projection = nativeProjection();
    const path = manager.getBranch();
    if (!path.some(entry => legacyHead(entry) || legacyEdit(entry))) return projection;
    const boundary = path.findLastIndex(contextBoundary);
    const head = path[boundary];
    let entries = projection.entries.map(item => item.sourceEntry);
    if (head && legacyHead(head)) {
      const kept = path.findIndex(entry => entry.id === head.data!.firstKeptEntryId);
      entries = [head, ...(kept >= 0 && kept < boundary ? path.slice(kept, boundary) : []),
        ...path.slice(boundary + 1)];
    }
    entries = entries.filter((entry, index) => !contextBoundary(entry) || index === 0);
    const replacements = new Map<string, { index: number; messages: AgentMessage[] }>();
    const edits = new Map<string, { index: number; entry: Extract<SessionEntry, { type: 'context_edit' }> }>();
    for (const [index, entry] of entries.entries()) {
      if (legacyEdit(entry)) entry.data!.targets.forEach((target, part) =>
        replacements.set(target, { index, messages: part === 0 ? entry.data!.messages : [] }));
      else if (entry.type === 'context_edit') edits.set(entry.targetId, { index, entry });
    }
    const projected = entries.map(sourceEntry => {
      const replacement = replacements.get(sourceEntry.id);
      const edit = edits.get(sourceEntry.id);
      let messages = replacement?.messages ?? (legacyHead(sourceEntry) ? sourceEntry.data!.messages
        : projectContextEntry(sourceEntry, undefined));
      if (edit && (!replacement || edit.index > replacement.index)) {
        messages = edit.entry.replacement === null ? [] : messages.flatMap(message =>
          projectContextEntry({ ...sourceEntry, type: 'message', message }, edit.entry));
      }
      return { sourceEntry, messages };
    });
    return { ...projection, entries: projected, messages: projected.flatMap(entry => entry.messages) };
  };
  return manager;
}
