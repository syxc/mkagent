/**
 * Backend selection for the durable store: a session directory with an
 * existing JSONL store stays on JSONL (its sidecar payload files are not
 * mechanically convertible), everything else lands on SQLite store.db.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import type { SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';
import { BunSqliteDatabase, openDurableStorage } from './storage/durable-storage.ts';

registerStorageConformance({ describe, it, expect }, 'Bun SQLite storage conformance', async use => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-conformance-'));
  const storage = await openDurableStorage(dir, BACKGROUND_CONTEXT);
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Bun SQLite counted writes', () => {
  it('counts affected rows without trigger writes and rolls back failed transactions', async () => {
    const database = new BunSqliteDatabase(new Database(':memory:'));
    try {
      await database.exec(`
        CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE audit (id INTEGER);
        CREATE TRIGGER inserted AFTER INSERT ON items BEGIN INSERT INTO audit VALUES (new.id); END;
      `);
      expect(await database.runCounted('INSERT INTO items VALUES (?, ?)', 1, 'first')).toBe(1);
      expect(await database.runCounted('UPDATE items SET value = ? WHERE id = ?', 'missing', 2)).toBe(0);
      let expired: SqliteExecutor | undefined;
      const failure = new Error('rollback fixture');
      await expect(database.transaction(async tx => {
        expired = tx;
        expect(await tx.runCounted('INSERT INTO items VALUES (?, ?)', 2, 'second')).toBe(1);
        throw failure;
      })).rejects.toBe(failure);
      expect(await database.get('SELECT count(*) AS count FROM items')).toEqual({ count: 1 });
      expect(await database.get('SELECT count(*) AS count FROM audit')).toEqual({ count: 1 });
      expect(() => expired!.runCounted('DELETE FROM items')).toThrow('no longer active');
      expect(await database.runCounted('DELETE FROM items')).toBe(1);
    } finally {
      await database.close();
    }
  });
});

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
