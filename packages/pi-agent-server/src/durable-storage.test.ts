/**
 * Backend selection for the durable store: a session directory with an
 * existing JSONL store stays on JSONL (its sidecar payload files are not
 * mechanically convertible), everything else lands on SQLite store.db.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openDurableStorage } from './storage/durable-storage.ts';

describe('openDurableStorage backend selection', () => {
  it('opens SQLite for a fresh session directory', async () => {
    const session = mkdtempSync(join(tmpdir(), 'durable-storage-fresh-'));
    const storeDir = join(session, 'durable-store');
    const storage = await openDurableStorage(storeDir, BACKGROUND_CONTEXT);
    try {
      expect(storage).toBeInstanceOf(SqliteStorage);
      expect(existsSync(join(storeDir, 'store.db'))).toBe(true);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  it('keeps JSONL for a directory that already has a main.jsonl store', async () => {
    const session = mkdtempSync(join(tmpdir(), 'durable-storage-jsonl-'));
    const storeDir = join(session, 'durable-store');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'main.jsonl'), '');
    const storage = await openDurableStorage(storeDir, BACKGROUND_CONTEXT);
    try {
      expect(storage).not.toBeInstanceOf(SqliteStorage);
      expect(existsSync(join(storeDir, 'store.db'))).toBe(false);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });
});
