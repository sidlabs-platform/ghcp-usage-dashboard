import { describe, it, expect, vi, beforeEach } from "vitest";

// Tracks the order of the operations (SQL exec statements and migration
// calls) database.ts runs during getDb(), so tests can assert relative
// ordering without depending on wall-clock timing.
let execCallOrder: string[] = [];

// Fakes for the better-sqlite3 handle. Named with the `mock` prefix so Vitest's
// vi.mock hoisting allows referencing them from the factory below.
const mockExec = vi.fn((sql: string) => {
  execCallOrder.push(sql);
});
const mockPragma = vi.fn();
const mockClose = vi.fn();
// `prepare()` return value is contextual: database.ts inspects the returned
// row shape (billing_sync_state's CREATE TABLE SQL, PRAGMA table_info, etc.)
// to decide which migration branches to take, so the fake must route on the
// query text rather than return one fixed shape for every call.
let billingSyncStateSql = "CREATE TABLE billing_sync_state (enterprise_slug TEXT, report_type TEXT, PRIMARY KEY (enterprise_slug, report_type))";
const mockPrepare = vi.fn((sql: string) => ({
  all: () => [],
  get: () => {
    if (sql.includes("sqlite_master") && sql.includes("billing_sync_state")) {
      return { sql: billingSyncStateSql };
    }
    return undefined;
  },
  run: () => ({ changes: 0 }),
}));
// A real `function` (not an arrow function) so it remains constructable via
// `new Database(...)`, matching how src/lib/db/database.ts uses the import.
const mockDatabaseCtor = vi.fn(function FakeDatabase() {
  return {
    exec: mockExec,
    pragma: mockPragma,
    prepare: mockPrepare,
    close: mockClose,
  };
});

vi.mock("better-sqlite3", () => ({
  default: mockDatabaseCtor,
}));

vi.mock("fs", () => ({
  default: {
    existsSync: () => true,
    mkdirSync: vi.fn(),
    readFileSync: () => "",
  },
}));

const mockMigrateCopilotAppMetrics = vi.fn();
vi.mock("./copilot-app-migration", () => ({
  migrateCopilotAppMetrics: mockMigrateCopilotAppMetrics,
}));

const mockMigrateSummaryCacheClassification = vi.fn(() => {
  execCallOrder.push("migrateSummaryCacheClassification()");
});
vi.mock("./summary-cache-migration", () => ({
  migrateSummaryCacheClassification: mockMigrateSummaryCacheClassification,
}));

describe("getDb migration failure handling", () => {
  beforeEach(() => {
    vi.resetModules();
    execCallOrder = [];
    billingSyncStateSql = "CREATE TABLE billing_sync_state (enterprise_slug TEXT, report_type TEXT, PRIMARY KEY (enterprise_slug, report_type))";
    mockExec.mockClear();
    mockPragma.mockClear();
    mockClose.mockClear();
    mockPrepare.mockClear();
    mockDatabaseCtor.mockClear();
    mockMigrateCopilotAppMetrics.mockReset();
    mockMigrateSummaryCacheClassification.mockClear();
  });

  it("closes and clears the cached handle, and rethrows the original error, when migrateCopilotAppMetrics throws", async () => {
    const migrationError = new Error("boom: copilot app migration failed");
    // Every call fails so we never traverse the unrelated post-migration code
    // paths (PK recreation, enterprise_slug backfill, etc.) that this test
    // does not need to exercise.
    mockMigrateCopilotAppMetrics.mockImplementation(() => {
      throw migrationError;
    });

    const { getDb } = await import("./database");

    expect(() => getDb()).toThrow(migrationError);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDatabaseCtor).toHaveBeenCalledTimes(1);

    // A second call must not reuse a partially-initialized handle: it should
    // attempt a brand-new Database() rather than silently returning the
    // handle that failed migration.
    expect(() => getDb()).toThrow(migrationError);
    expect(mockDatabaseCtor).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it("runs migrateSummaryCacheClassification AFTER the PK-migration table recreation, not before", async () => {
    // Force needsPKMigration = true: the old schema's billing_sync_state PK
    // is a single column, so its CREATE TABLE SQL lacks
    // "PRIMARY KEY (enterprise_slug...".
    billingSyncStateSql = "CREATE TABLE billing_sync_state (report_type TEXT PRIMARY KEY)";

    const { getDb } = await import("./database");
    getDb();

    expect(mockMigrateSummaryCacheClassification).toHaveBeenCalledTimes(1);

    const classificationIndex = execCallOrder.indexOf("migrateSummaryCacheClassification()");
    expect(classificationIndex).toBeGreaterThan(-1);

    // Every DROP TABLE issued by the PK-migration recreation block (which
    // would otherwise wipe out daily_aggregate_cache/user_period_summary/
    // team_summary_cache immediately after classification recomputed them)
    // must occur strictly before the classification call, so the recompute
    // survives and runs against the final, post-migration schema.
    const dropTableIndexes = execCallOrder
      .map((sql, i) => (sql.includes("DROP TABLE") ? i : -1))
      .filter((i) => i !== -1);
    expect(dropTableIndexes.length).toBeGreaterThan(0);
    for (const dropIndex of dropTableIndexes) {
      expect(dropIndex).toBeLessThan(classificationIndex);
    }
  });
});
