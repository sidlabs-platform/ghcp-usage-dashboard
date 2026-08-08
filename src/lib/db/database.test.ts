import { describe, it, expect, vi, beforeEach } from "vitest";

// Fakes for the better-sqlite3 handle. Named with the `mock` prefix so Vitest's
// vi.mock hoisting allows referencing them from the factory below.
const mockExec = vi.fn();
const mockPragma = vi.fn();
const mockClose = vi.fn();
const mockPrepare = vi.fn(() => ({
  all: () => [],
  get: () => undefined,
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

describe("getDb migration failure handling", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExec.mockClear();
    mockPragma.mockClear();
    mockClose.mockClear();
    mockPrepare.mockClear();
    mockDatabaseCtor.mockClear();
    mockMigrateCopilotAppMetrics.mockReset();
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
});
