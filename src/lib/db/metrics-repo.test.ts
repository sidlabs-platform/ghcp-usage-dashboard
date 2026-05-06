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
  upsertEnterpriseDayMetrics,
  getEnterpriseMetrics,
  resolveEnterpriseId,
  hasEnterpriseDataForRange,
  upsertUserDayMetrics,
  getUserMetrics,
  upsertOrgDayMetrics,
  getOrgMetrics,
  getAllOrgSlugs,
  batchUpsertUserDayMetrics,
  getUserMetricsByLogin,
  getDistinctUsers,
  getAllUserMetrics,
  getAggregatedDailySummary,
  getFilteredOrgMetrics,
  getAllOrgMetrics,
  recordSync,
  isSynced,
  getLatestSyncDay,
  getSyncStatus,
  hasOrgDataForRange,
  clearEmptySyncEntries,
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

describe("enterprise metrics", () => {
  beforeEach(() => {
    db.exec("DELETE FROM enterprise_daily_metrics");
  });

  const baseDayTotal = {
    day: "2024-01-10",
    enterprise_id: "ent-123",
    daily_active_users: 10,
    weekly_active_users: 25,
    monthly_active_users: 50,
    monthly_active_agent_users: 5,
    monthly_active_chat_users: 20,
    daily_active_cli_users: 3,
    code_generation_activity_count: 100,
    code_acceptance_activity_count: 70,
    user_initiated_interaction_count: 200,
    loc_suggested_to_add_sum: 500,
    loc_suggested_to_delete_sum: 50,
    loc_added_sum: 400,
    loc_deleted_sum: 80,
    totals_by_ide: [],
    totals_by_feature: [],
    totals_by_language_feature: [],
    totals_by_model_feature: [],
    totals_by_language_model: [],
  };

  it("upserts and retrieves enterprise metrics", () => {
    upsertEnterpriseDayMetrics("ent1", baseDayTotal as any);
    const results = getEnterpriseMetrics("2024-01-01", "2024-01-31");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_users).toBe(10);
    expect(results[0].loc_added_sum).toBe(400);
  });

  it("resolveEnterpriseId finds from enterprise metrics", () => {
    upsertEnterpriseDayMetrics("ent1", baseDayTotal as any);
    expect(resolveEnterpriseId(["ent1"])).toBe("ent-123");
  });

  it("resolveEnterpriseId returns null when no data", () => {
    expect(resolveEnterpriseId(["nonexistent"])).toBeNull();
  });

  it("hasEnterpriseDataForRange returns true when data exists", () => {
    upsertEnterpriseDayMetrics("ent1", baseDayTotal as any);
    expect(hasEnterpriseDataForRange("ent-123", "2024-01-01", "2024-01-31")).toBe(true);
  });

  it("hasEnterpriseDataForRange returns false for empty range", () => {
    expect(hasEnterpriseDataForRange("ent-123", "2025-01-01", "2025-01-31")).toBe(false);
  });
});

describe("upsertUserDayMetrics / getUserMetrics", () => {
  it("upserts and retrieves user metrics with chat mode extraction", () => {
    const record = {
      day: "2024-01-10", enterprise_id: "ent-123", user_id: 1, user_login: "dev1",
      code_generation_activity_count: 5, code_acceptance_activity_count: 3,
      user_initiated_interaction_count: 10, loc_suggested_to_add_sum: 100,
      loc_suggested_to_delete_sum: 20, loc_added_sum: 80, loc_deleted_sum: 15,
      used_agent: true, used_chat: true, used_cli: false,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: false,
      totals_by_ide: [], totals_by_feature: [
        { feature: "chat_panel_agent_mode", user_initiated_interaction_count: 7, code_generation_activity_count: 0, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0 },
      ],
      totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [],
    } as any;
    upsertUserDayMetrics("ent1", record);
    const results = getUserMetrics("ent-123", "2024-01-01", "2024-01-31");
    expect(results).toHaveLength(1);
    expect(results[0].user_login).toBe("dev1");
    expect(results[0].chat_panel_agent_mode).toBe(7);
  });
});

describe("upsertOrgDayMetrics / getOrgMetrics / getAllOrgSlugs", () => {
  const orgDayTotal = {
    day: "2024-01-10", enterprise_id: "ent-123",
    daily_active_users: 10, weekly_active_users: 30, monthly_active_users: 50,
    monthly_active_agent_users: 5, monthly_active_chat_users: 8, daily_active_cli_users: 2,
    code_generation_activity_count: 100, code_acceptance_activity_count: 80,
    user_initiated_interaction_count: 200, loc_suggested_to_add_sum: 500,
    loc_suggested_to_delete_sum: 50, loc_added_sum: 400, loc_deleted_sum: 80,
    totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
    totals_by_model_feature: [], totals_by_language_model: [],
  };

  it("upserts and retrieves org metrics", () => {
    upsertOrgDayMetrics("ent1", "my-org", orgDayTotal as any);
    const results = getOrgMetrics("my-org", "2024-01-01", "2024-01-31");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_users).toBe(10);
  });

  it("getAllOrgSlugs lists distinct org slugs", () => {
    upsertOrgDayMetrics("ent1", "org-a", orgDayTotal as any);
    upsertOrgDayMetrics("ent1", "org-b", orgDayTotal as any);
    const slugs = getAllOrgSlugs();
    expect(slugs).toContain("org-a");
    expect(slugs).toContain("org-b");
  });
});

describe("batchUpsertUserDayMetrics", () => {
  it("inserts multiple records in a transaction", () => {
    const records = [
      { day: "2024-01-20", enterprise_id: "ent-123", user_id: 10, user_login: "batch1", code_generation_activity_count: 1, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, used_agent: false, used_chat: false, used_cli: false, used_copilot_code_review_active: false, used_copilot_code_review_passive: false, used_copilot_coding_agent: false, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] },
      { day: "2024-01-20", enterprise_id: "ent-123", user_id: 11, user_login: "batch2", code_generation_activity_count: 2, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, used_agent: false, used_chat: false, used_cli: false, used_copilot_code_review_active: false, used_copilot_code_review_passive: false, used_copilot_coding_agent: false, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] },
    ] as any[];
    const count = batchUpsertUserDayMetrics("ent1", records);
    expect(count).toBe(2);
  });
});

describe("getUserMetricsByLogin", () => {
  it("retrieves metrics for a specific user", () => {
    const record = { day: "2024-01-22", enterprise_id: "ent-123", user_id: 20, user_login: "specific-user", code_generation_activity_count: 5, code_acceptance_activity_count: 3, user_initiated_interaction_count: 10, loc_suggested_to_add_sum: 50, loc_suggested_to_delete_sum: 5, loc_added_sum: 40, loc_deleted_sum: 2, used_agent: false, used_chat: true, used_cli: false, used_copilot_code_review_active: false, used_copilot_code_review_passive: false, used_copilot_coding_agent: false, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] } as any;
    upsertUserDayMetrics("ent1", record);
    const results = getUserMetricsByLogin("specific-user", "2024-01-01", "2024-01-31");
    expect(results).toHaveLength(1);
    expect(results[0].code_generation_activity_count).toBe(5);
  });
});

describe("getDistinctUsers", () => {
  it("returns distinct user logins", () => {
    const users = getDistinctUsers("ent-123", "2024-01-01", "2024-01-31");
    expect(users.length).toBeGreaterThanOrEqual(1);
  });
});

describe("getAllUserMetrics", () => {
  it("returns all user metrics without enterprise_id filter", () => {
    const results = getAllUserMetrics("2024-01-01", "2024-01-31");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("getAggregatedDailySummary", () => {
  it("aggregates user metrics into daily summaries with rolling windows", () => {
    const summary = getAggregatedDailySummary("2024-01-01", "2024-01-31");
    expect(summary.length).toBeGreaterThanOrEqual(1);
    expect(summary[0].daily_active_users).toBeGreaterThanOrEqual(1);
    expect(typeof summary[0].weekly_active_users).toBe("number");
    expect(typeof summary[0].monthly_active_users).toBe("number");
  });
});

describe("getFilteredOrgMetrics / getAllOrgMetrics", () => {
  it("getAllOrgMetrics aggregates across all orgs per day", () => {
    upsertOrgDayMetrics("ent1", "agg-org1", { day: "2024-01-15", enterprise_id: "ent-123", daily_active_users: 5, weekly_active_users: 10, monthly_active_users: 20, monthly_active_agent_users: 2, monthly_active_chat_users: 3, daily_active_cli_users: 1, code_generation_activity_count: 50, code_acceptance_activity_count: 40, user_initiated_interaction_count: 100, loc_suggested_to_add_sum: 200, loc_suggested_to_delete_sum: 30, loc_added_sum: 150, loc_deleted_sum: 20, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] } as any);
    upsertOrgDayMetrics("ent1", "agg-org2", { day: "2024-01-15", enterprise_id: "ent-123", daily_active_users: 3, weekly_active_users: 7, monthly_active_users: 15, monthly_active_agent_users: 1, monthly_active_chat_users: 2, daily_active_cli_users: 0, code_generation_activity_count: 30, code_acceptance_activity_count: 20, user_initiated_interaction_count: 60, loc_suggested_to_add_sum: 100, loc_suggested_to_delete_sum: 10, loc_added_sum: 80, loc_deleted_sum: 10, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] } as any);
    const results = getAllOrgMetrics("2024-01-15", "2024-01-15");
    const day = results.find((r) => r.day === "2024-01-15");
    expect(day).toBeDefined();
    expect(day!.daily_active_users).toBeGreaterThanOrEqual(8);
  });

  it("getFilteredOrgMetrics filters to specific org slugs", () => {
    const results = getFilteredOrgMetrics(["agg-org1"], "2024-01-15", "2024-01-15");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].daily_active_users).toBe(5);
  });
});

describe("recordSync / isSynced / getLatestSyncDay / getSyncStatus", () => {
  it("records a sync and checks isSynced", () => {
    recordSync("ent1", "enterprise", "ent1", "2024-01-10", 5);
    expect(isSynced("ent1", "enterprise", "ent1", "2024-01-10")).toBe(true);
    expect(isSynced("ent1", "enterprise", "ent1", "2024-01-11")).toBe(false);
  });

  it("getLatestSyncDay returns the latest day", () => {
    recordSync("ent1", "enterprise", "ent1", "2024-01-12", 3);
    const latest = getLatestSyncDay("ent1", "enterprise", "ent1");
    expect(latest).toBe("2024-01-12");
  });

  it("getSyncStatus returns grouped sync info", () => {
    const status = getSyncStatus(["ent1"]);
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(status[0].days_synced).toBeGreaterThanOrEqual(1);
  });
});

describe("hasOrgDataForRange", () => {
  it("returns true when org has data", () => {
    expect(hasOrgDataForRange("my-org", "2024-01-01", "2024-01-31")).toBe(true);
  });

  it("returns false for unknown org", () => {
    expect(hasOrgDataForRange("nonexistent", "2024-01-01", "2024-01-31")).toBe(false);
  });
});

describe("clearEmptySyncEntries", () => {
  it("removes zero-count sync entries", () => {
    recordSync("ent1", "enterprise", "ent1", "2024-01-05", 0);
    const removed = clearEmptySyncEntries(["ent1"]);
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});
