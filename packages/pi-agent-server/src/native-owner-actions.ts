/** Keep native before hooks and local replacement callbacks in their original command coroutine. */
import type { AgentSession, ExtensionCommandContextActions } from '@mkagent/pi-durable-coding/native';
import type { PiNativeOwnerRequest } from '../../shared/src/agent/backend/pi/native-owner-protocol.ts';
import type { CodingHost } from './coding-host.ts';
import { setupSessionManager } from './native-user-input.ts';

export interface NativeOwnerActionsHost {
  source(): CodingHost;
  replace(request: PiNativeOwnerRequest, runTarget: (target: CodingHost, signal: AbortSignal) => Promise<void>): Promise<void>;
}

function textContent(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === 'string' ? content : content.flatMap(part =>
    part.type === 'text' && part.text ? [part.text] : []).join('');
}

/** The transport can release barriers, but cannot invoke a callback or lifecycle hook. */
export function nativeOwnerActions(host: NativeOwnerActionsHost): Pick<ExtensionCommandContextActions, 'newSession' | 'fork' | 'switchSession'> {
  return {
    newSession: async options => {
      const source = host.source();
      const before = await source.session.extensionRunner.emit({ type: 'session_before_switch', reason: 'new' });
      if (before?.cancel) return { cancelled: true };
      let sourceReference: PiNativeOwnerRequest['sourceReference'];
      if (options?.parentSession) {
        await source.flush();
        const { entryIds: _entryIds, ...reference } = await source.projection.flush();
        sourceReference = reference;
      }
      await host.replace({
        sourceNativeSessionId: source.session.sessionId,
        sourceReference,
        operation: { type: 'new', ...(options?.parentSession ? { parentSession: options.parentSession } : {}) },
      }, async (target, signal) => {
        signal.throwIfAborted();
        if (options?.setup) {
          await options.setup(setupSessionManager(target.session.sessionManager));
          signal.throwIfAborted();
          target.session.refreshContext();
          await target.commitSetup();
        }
        await startTarget(target, 'new', options?.withSession, signal);
      });
      return { cancelled: false };
    },
    fork: async (entryId, options) => {
      const source = host.source();
      const position = options?.position ?? 'before';
      const before = await source.session.extensionRunner.emit({ type: 'session_before_fork', entryId, position });
      if (before?.cancel) return { cancelled: true };
      const entry = source.session.sessionManager.getEntry(entryId);
      if (!entry || (position === 'before' && (entry.type !== 'message' || entry.message.role !== 'user'))) {
        throw new Error('Invalid entry ID for forking');
      }
      await source.flush();
      const nativeLeafId = position === 'at' ? entry.id : entry.parentId;
      const durableEntryId = nativeLeafId === null ? null : source.journal.durableId(nativeLeafId);
      if (durableEntryId === undefined) throw new Error(`Native branch anchor not persisted: ${nativeLeafId}`);
      const selectedText = position === 'before' && entry.type === 'message' && entry.message.role === 'user'
        ? textContent(entry.message.content) : undefined;
      const { entryIds: _entryIds, ...sourceReference } = await source.projection.flush();
      await host.replace({
        sourceNativeSessionId: source.session.sessionId, operation: { type: 'fork', entryId, position },
        sourceReference, fork: { nativeLeafId, durableEntryId, selectedText },
      }, (target, signal) => startTarget(target, 'fork', options?.withSession, signal));
      return { cancelled: false, selectedText };
    },
    switchSession: async (sessionPath, options) => {
      const source = host.source();
      const before = await source.session.extensionRunner.emit({
        type: 'session_before_switch', reason: 'resume', targetSessionFile: sessionPath,
      });
      if (before?.cancel) return { cancelled: true };
      await host.replace({
        sourceNativeSessionId: source.session.sessionId, operation: { type: 'switch', sessionPath },
      }, (target, signal) => startTarget(target, 'resume', options?.withSession, signal));
      return { cancelled: false };
    },
  };
}

async function startTarget(
  target: CodingHost, reason: 'new' | 'fork' | 'resume',
  withSession: ((context: ReturnType<AgentSession['createReplacedSessionContext']>) => Promise<void>) | undefined,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await target.start(reason);
  signal.throwIfAborted();
  await withSession?.(target.session.createReplacedSessionContext());
  signal.throwIfAborted();
  await target.waitForIdle();
  signal.throwIfAborted();
  await target.flush();
}
