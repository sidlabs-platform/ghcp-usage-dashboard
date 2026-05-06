import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  extractChatModeCounts,
  acquireSyncLock,
  releaseSyncLock,
  heartbeatSyncLock,
  isSyncLocked,
  forceReleaseSyncLock,
  getSyncLockInfo,
} from "./metrics-repo";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.prepare("DELETE FROM sync_lock").run();
});

describe("extractChatModeCounts", () => {
  it("returns zeros for empty features", () => {
    const result = extractChatModeCounts([]);
    expect(result).toEqual({ ask: 0, edit: 0, plan: 0, agent: 0, custom: 0, unknown: 0 });
  });

  it("extracts chat mode counts from feature entries", () => {
    const features = [
      { feature: "chat_panel_ask_mode", user_initiated_interaction_count: 10 },
      { feature: "chat_panel_agent_mode", user_initiated_interaction_count: 5 },
      { feature: "code_completion", user_initiated_interaction_count: 99 },
    ] as any[];
    const result = extractChatModeCounts(features);
    expect(result.ask).toBe(10);
    expect(result.agent).toBe(5);
    expect(result.edit).toBe(0);
  });

  it("sums counts for duplicate features", () => {
    const features = [
      { feature: "chat_panel_edit_mode", user_initiated_interaction_count: 3 },
      { feature: "chat_panel_edit_mode", user_initiated_interaction_count: 7 },
    ] as any[];
    expect(extractChatModeCounts(features).edit).toBe(10);
  });
});

describe("sync lock", () => {
  it("acquireSyncLock returns true when no lock held", () => {
    expect(acquireSyncLock()).toBe(true);
  });

  it("acquireSyncLock returns false when lock already held", () => {
    acquireSyncLock();
    expect(acquireSyncLock()).toBe(false);
  });

  it("releaseSyncLock frees the lock", () => {
    acquireSyncLock();
    releaseSyncLock();
    expect(isSyncLocked()).toBe(false);
  });

  it("isSyncLocked returns true when lock is held", () => {
    acquireSyncLock();
    expect(isSyncLocked()).toBe(true);
  });

  it("forceReleaseSyncLock returns lock info", () => {
    acquireSyncLock();
    const info = forceReleaseSyncLock();
    expect(info).not.toBeNull();
    expect(info!.acquired_at).toBeDefined();
    expect(isSyncLocked()).toBe(false);
  });

  it("forceReleaseSyncLock returns null when no lock", () => {
    expect(forceReleaseSyncLock()).toBeNull();
  });

  it("getSyncLockInfo returns locked state", () => {
    acquireSyncLock();
    const info = getSyncLockInfo();
    expect(info.locked).toBe(true);
    expect(info.acquired_at).toBeDefined();
    expect(info.age_seconds).toBeGreaterThanOrEqual(0);
  });

  it("getSyncLockInfo returns unlocked state", () => {
    expect(getSyncLockInfo().locked).toBe(false);
  });

  it("heartbeatSyncLock extends expiry", () => {
    acquireSyncLock();
    const before = getSyncLockInfo().expires_at;
    heartbeatSyncLock();
    const after = getSyncLockInfo().expires_at;
    expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before!).getTime());
  });
});
