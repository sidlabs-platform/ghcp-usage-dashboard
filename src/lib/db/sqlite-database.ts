import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";

export type SqliteRow = Record<string, SQLOutputValue>;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

function normalizeValue(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}

function normalizeParameter(parameter: unknown): SQLInputValue | Record<string, SQLInputValue> {
  if (
    parameter !== null &&
    typeof parameter === "object" &&
    !(parameter instanceof Uint8Array)
  ) {
    return Object.fromEntries(
      Object.entries(parameter as Record<string, unknown>).map(([key, value]) => [key, normalizeValue(value)]),
    );
  }
  return normalizeValue(parameter);
}

function normalizeParameters(params: unknown[]): SQLInputValue[] {
  return params.map(normalizeParameter) as SQLInputValue[];
}

/** A prepared statement with the synchronous API used by dashboard repositories. */
export class SqliteStatement {
  constructor(private readonly statement: StatementSync) {
    // better-sqlite3 accepts `{ name: value }` for `$name`, `:name`, and `@name`.
    this.statement.setAllowBareNamedParameters(true);
  }

  run(...params: unknown[]): SqliteRunResult {
    const result = this.statement.run(...normalizeParameters(params));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get<Result = unknown>(...params: unknown[]): Result | undefined {
    return this.statement.get(...normalizeParameters(params)) as Result | undefined;
  }

  all<Result = unknown>(...params: unknown[]): Result[] {
    return this.statement.all(...normalizeParameters(params)) as Result[];
  }

  iterate<Result = unknown>(...params: unknown[]): IterableIterator<Result> {
    return this.statement.iterate(...normalizeParameters(params)) as IterableIterator<Result>;
  }
}

/**
 * Synchronous SQLite connection backed by Node's built-in `node:sqlite`.
 *
 * The wrapper intentionally mirrors the small better-sqlite3 API subset used
 * by the dashboard so repository SQL and existing database files stay intact.
 */
export class SqliteDatabase {
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(location: string) {
    this.database = new DatabaseSync(location);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(clause: string): void {
    this.database.exec(`PRAGMA ${clause}`);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database.prepare(sql));
  }

  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): (...args: Args) => Result {
    return (...args: Args): Result => {
      const isNested = this.transactionDepth > 0;
      const savepoint = `dashboard_tx_${this.savepointSequence++}`;
      this.exec(isNested ? `SAVEPOINT ${savepoint}` : "BEGIN");
      this.transactionDepth++;

      try {
        const result = fn(...args);
        this.exec(isNested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        try {
          if (isNested) {
            this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } else {
            this.exec("ROLLBACK");
          }
        } catch {
          // Preserve the original callback/commit error if rollback also fails.
        }
        throw error;
      } finally {
        this.transactionDepth--;
      }
    };
  }

  close(): void {
    this.database.close();
  }
}

export default SqliteDatabase;