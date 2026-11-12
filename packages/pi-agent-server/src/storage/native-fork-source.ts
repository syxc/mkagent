/** Verify a native fork copy against the product's approved closed source before opening a Harness. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@earendil-works/chord';
import { ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable';
import { readNativeSessionSnapshot } from '@mkagent/coding-runtime/durable';
import {
  parseNativeSessionReference, type NativeSessionReference,
} from '../../../shared/src/sessions/native-session-reference.ts';
import { openDurableStorage } from './durable-storage.ts';
import { encodeNativeSessionProjection, nativeSessionPaths } from './native-session-projection.ts';

export interface NativeForkSource {
  leaf: string | null;
  source: NativeSessionReference;
}

/** Reject symbolic links and special files before any store copy or database read. */
export function assertNativeForkStoreItem(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('Pi native fork refuses a symbolic link or special store file');
  }
}

/** Use the same persisted conversation selection during verification and actual kernel opening. */
export function readBranchConversationId(storeDir: string): ConversationId | undefined {
  const marker = join(storeDir, 'conversation-id.txt');
  if (!existsSync(marker)) return undefined;
  const raw = readFileSync(marker, 'utf8').trim();
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || String(id) !== raw) throw new Error('Invalid durable branch conversation id');
  return id as ConversationId;
}

/** Read the owned, paused copy and close storage before path rewriting or inherited-task handling. */
export async function verifyNativeForkStore(
  storeDir: string, sourcePath: string, fork: NativeForkSource, context: Context,
): Promise<void> {
  const reference = parseNativeSessionReference(fork.source);
  if (!reference || reference.sessionFile !== nativeSessionPaths(sourcePath).sessionFile) {
    throw new Error('Pi fork closed native source reference does not match its path');
  }
  const conversationId = readBranchConversationId(storeDir) ?? ROOT_CONVERSATION_ID;
  if (conversationId !== reference.conversationId) {
    throw new Error('Pi fork closed native source conversation does not match');
  }
  const storage = await openDurableStorage(storeDir, context);
  try {
    const snapshot = await readNativeSessionSnapshot(storage, conversationId, context);
    const encoded = encodeNativeSessionProjection(snapshot, { sessionPath: sourcePath, sessionId: reference.sessionId });
    if (!isDeepStrictEqual(parseNativeSessionReference(encoded.descriptor), reference)) {
      throw new Error('Pi fork closed native source reference does not match the copied journal');
    }
    if (fork.leaf !== null && !snapshot.entries.some(entry => entry.id === fork.leaf)) {
      throw new Error('Pi native fork selected leaf not found');
    }
  } finally {
    await storage.close(context);
  }
}
