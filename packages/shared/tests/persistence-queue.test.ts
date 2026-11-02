/**
 * Tests for SessionPersistenceQueue in sessions/persistence-queue.ts
 *
 * Key behavior: Writes to the same session must be serialized to prevent
 * race conditions when rapid successive flushes write to the same .tmp file.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fsPromises from 'fs/promises';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionPersistenceQueue } from '../src/sessions/persistence-queue.ts';
import type { StoredSession } from '../src/sessions/types.ts';

// Create a minimal stored session for testing
function createTestSession(
  id: string,
  workspaceRootPath: string,
  sdkSessionId?: string
): StoredSession {
  return {
    id,
    workspaceRootPath,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastMessageAt: Date.now(),
    messages: [],
    sdkSessionId,
  };
}

describe('SessionPersistenceQueue', () => {
  let testDir: string;
  let queue: SessionPersistenceQueue;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `persistence-queue-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // Create sessions subdirectory structure
    mkdirSync(join(testDir, 'sessions', 'test-session'), { recursive: true });
    // Use 0ms debounce for immediate writes in tests
    queue = new SessionPersistenceQueue(0);
  });

  afterEach(async () => {
    await queue.flushAll();
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('flushAll waits for an active atomic rename before teardown', async () => {
    const rename = fsPromises.rename;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return rename(...args);
    });
    let writing: Promise<void> | undefined;
    let draining: Promise<void> | undefined;
    try {
      queue.enqueue(createTestSession('test-session', testDir, 'active-write'));
      writing = queue.flush('test-session');
      await entered.promise;
      expect(queue.pendingCount).toBe(0);
      let drained = false;
      draining = queue.flushAll().then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      release.resolve();
      await draining;
      expect(existsSync(join(testDir, 'sessions', 'test-session', 'session.jsonl'))).toBe(true);
    } finally {
      release.resolve();
      await writing;
      await draining;
      renameSpy.mockRestore();
    }
  });

  it('drains timer writes before removing the workspace', async () => {
    const rename = fsPromises.rename;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const errors = spyOn(console, 'error');
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      try {
        return await rename(...args);
      } finally {
        finished.resolve();
      }
    });
    try {
      queue.enqueue(createTestSession('test-session', testDir));
      await entered.promise;
      setImmediate(() => release.resolve());
      await queue.flushAll();
      rmSync(testDir, { recursive: true, force: true });
      await finished.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await finished.promise;
      renameSpy.mockRestore();
      errors.mockRestore();
    }
  });

  it('writes session to disk', async () => {
    const session = createTestSession('test-session', testDir, 'sdk-123');
    queue.enqueue(session);
    await queue.flush('test-session');

    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const header = JSON.parse(content.split('\n')[0]);
    expect(header.sdkSessionId).toBe('sdk-123');
  });

  it('serializes concurrent flushes for the same session', async () => {
    // This test verifies the fix for the race condition where
    // clearSessionForRecovery() + onSdkSessionIdUpdate() would
    // both flush rapidly and corrupt each other's writes.

    // Simulate the problematic sequence:
    // 1. First write with sdkSessionId = undefined (clearing)
    const session1 = createTestSession('test-session', testDir, undefined);
    queue.enqueue(session1);
    const flush1 = queue.flush('test-session');

    // 2. Second write with new sdkSessionId (before first completes)
    const session2 = createTestSession('test-session', testDir, 'new-thread-id');
    queue.enqueue(session2);
    const flush2 = queue.flush('test-session');

    // Wait for both to complete
    await Promise.all([flush1, flush2]);

    // The final file should have the NEWER data (new-thread-id)
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const header = JSON.parse(content.split('\n')[0]);

    // Before the fix, this could randomly be undefined due to race condition
    expect(header.sdkSessionId).toBe('new-thread-id');
  });

  it('allows parallel writes to different sessions', async () => {
    // Different sessions should write in parallel without blocking each other
    mkdirSync(join(testDir, 'sessions', 'session-a'), { recursive: true });
    mkdirSync(join(testDir, 'sessions', 'session-b'), { recursive: true });

    const sessionA = createTestSession('session-a', testDir, 'id-a');
    const sessionB = createTestSession('session-b', testDir, 'id-b');

    queue.enqueue(sessionA);
    queue.enqueue(sessionB);

    // Flush both in parallel
    await Promise.all([
      queue.flush('session-a'),
      queue.flush('session-b'),
    ]);

    // Both should be written correctly
    const contentA = readFileSync(
      join(testDir, 'sessions', 'session-a', 'session.jsonl'),
      'utf-8'
    );
    const contentB = readFileSync(
      join(testDir, 'sessions', 'session-b', 'session.jsonl'),
      'utf-8'
    );

    expect(JSON.parse(contentA.split('\n')[0]).sdkSessionId).toBe('id-a');
    expect(JSON.parse(contentB.split('\n')[0]).sdkSessionId).toBe('id-b');
  });
});
