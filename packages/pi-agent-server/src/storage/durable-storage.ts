/**
 * Durable storage backends for the kernel.
 *
 * pi-durable ships a Node SQLite backend, but it is built on `node:sqlite`,
 * which Bun does not implement; its portable SQLite core however runs over any
 * asynchronous `SqliteDatabase` facade. `BunSqliteDatabase` provides that
 * facade on `bun:sqlite`, mirroring the operation-queueing and transaction
 * semantics of chord's `NodeSqliteDatabase`.
 *
 * `openDurableStorage` picks the backend per session directory: sessions that
 * already carry a JSONL store keep it (the big-payload sidecars it uses are
 * not mechanically convertible), everything else — new sessions and legacy
 * migrations alike — goes to SQLite, which the upstream README recommends for
 * long-running agents because it does not keep the whole history in memory.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database, type Statement } from 'bun:sqlite';
import { type Context } from '@earendil-works/chord/context';
import type { Storage } from '@earendil-works/pi-durable';
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Runs operations in call order: an operation starts immediately when nothing
 * is running or waiting, otherwise it waits for everything before it. Mirrors
 * chord's queue so unrelated operations cannot interleave between a
 * transaction's BEGIN and COMMIT.
 */
class SerialOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending++;
    // Publish the barrier before the operation starts, so calls it makes synchronously wait behind it.
    const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
    this.tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.pending--;
      releaseBarrier();
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.pending++;
    return this.release(this.tail.then(operation));
  }

  private release<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.finally(() => {
      this.pending--;
    });
    this.tail = settled.then(() => undefined, () => undefined);
    return settled;
  }
}

/** Prepares each statement once per SQL text; database and transaction handles share the cache. */
class BunSqliteExecutor {
  constructor(
    protected readonly database: Database,
    protected readonly statements: Map<string, Statement>,
  ) {}

  exec(sql: string): Promise<void> {
    return this.runOperation(() => {
      this.database.exec(sql);
    });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => {
      this.statement(sql).run(...params);
    });
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(() => {
      // bun:sqlite yields null for no row; the contract expects undefined.
      return (this.statement(sql).get(...params) ?? undefined) as T | undefined;
    });
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.statement(sql).all(...params) as T[]);
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  protected runOperation<T>(operation: () => T): Promise<T> {
    return Promise.resolve(operation());
  }
}

class BunSqliteTransaction extends BunSqliteExecutor {
  constructor(
    database: Database,
    statements: Map<string, Statement>,
    private readonly scope: { active: boolean },
  ) {
    super(database, statements);
  }

  protected override runOperation<T>(operation: () => T): Promise<T> {
    if (!this.scope.active) throw new Error('SQLite transaction handle is no longer active');
    return Promise.resolve(operation());
  }
}

export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  private readonly access = new SerialOperationQueue();
  private closed = false;

  constructor(database: Database) {
    super(database, new Map());
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.runAsync(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      const scope = { active: true };
      try {
        const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
        scope.active = false;
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        scope.active = false;
        try {
          this.database.exec('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'SQLite transaction failed and rollback failed');
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.access.run(() => {
      if (this.closed) return;
      this.closed = true;
      try {
        this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        this.database.close();
      }
    });
  }

  protected override runOperation<T>(operation: () => T): Promise<T> {
    return this.access.run(operation);
  }
}

export interface BunSqliteStorageOptions {
  walAutoCheckpointPages?: number;
  busyTimeoutMs?: number;
}

/** Open and configure a Bun-backed SQLite database facade, then wrap it in durable's SQLite storage. */
export async function openBunSqliteStorage(
  path: string,
  options: BunSqliteStorageOptions = {},
): Promise<SqliteStorage> {
  const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
  const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const database = new Database(path);
  const adapter = new BunSqliteDatabase(database);
  try {
    await adapter.exec('PRAGMA journal_mode = WAL');
    await adapter.exec('PRAGMA synchronous = NORMAL');
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
    await adapter.exec(`PRAGMA busy_timeout = ${timeout}`);
    return await SqliteStorage.open(adapter);
  } catch (error) {
    try {
      await adapter.close();
    } catch {
      // Preserve the configuration failure.
    }
    throw error;
  }
}

const STORE_DB_FILE = 'store.db';
const STORE_MAIN_FILE = 'main.jsonl';

/**
 * Open the durable store for a session directory. Sessions with an existing
 * JSONL store keep reading it unchanged; every other case lands on SQLite.
 */
export async function openDurableStorage(storeDir: string, context: Context): Promise<Storage> {
  if (existsSync(join(storeDir, STORE_MAIN_FILE))) {
    return openNodeJsonlStorage(storeDir, context);
  }
  mkdirSync(storeDir, { recursive: true });
  return openBunSqliteStorage(join(storeDir, STORE_DB_FILE));
}
