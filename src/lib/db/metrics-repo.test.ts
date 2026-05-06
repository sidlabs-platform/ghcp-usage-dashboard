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

  it("stores and retrieves totals_by_cli and pull_requests fields", () => {
    const record = {
      ...baseDayTotal,
      day: "2024-01-11",
      totals_by_cli: [{ name: "ghcs", total_chats: 12 }],
      pull_requests: { total_created: 5, total_reviewed: 3, total_merged: 4, total_suggestions: 2, total_applied_suggestions: 1, total_created_by_copilot: 1, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 1, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 1, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 45, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null },
    };
    upsertEnterpriseDayMetrics("ent1", record as any);
    const results = getEnterpriseMetrics("2024-01-11", "2024-01-11");
    expect(results).toHaveLength(1);
    expect(results[0].totals_by_cli).toEqual([{ name: "ghcs", total_chats: 12 }]);
    expect(results[0].pull_requests!.total_created).toBe(5);
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

  it("stores and retrieves totals_by_cli and agent_edit fields", () => {
    const record = {
      day: "2024-01-11", enterprise_id: "ent-123", user_id: 99, user_login: "cli-user",
      code_generation_activity_count: 2, code_acceptance_activity_count: 1,
      user_initiated_interaction_count: 3, loc_suggested_to_add_sum: 10,
      loc_suggested_to_delete_sum: 1, loc_added_sum: 8, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: true,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: true,
      totals_by_ide: [], totals_by_feature: [],
      totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [],
      totals_by_cli: [{ name: "ghcs", total_chats: 5 }],
      agent_edit: { files_changed: 3, lines_added: 20, lines_deleted: 5 },
    } as any;
    upsertUserDayMetrics("ent1", record);
    const results = getUserMetricsByLogin("cli-user", "2024-01-01", "2024-01-31");
    expect(results).toHaveLength(1);
    expect(results[0].totals_by_cli).toEqual([{ name: "ghcs", total_chats: 5 }]);
    expect(results[0].agent_edit).toEqual({ files_changed: 3, lines_added: 20, lines_deleted: 5 });
    expect(results[0].used_cli).toBe(true);
    expect(results[0].used_copilot_coding_agent).toBe(true);
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

  it("stores and retrieves totals_by_cli for org metrics", () => {
    const record = { ...orgDayTotal, day: "2024-01-12", totals_by_cli: [{ name: "ghcs", total_chats: 8 }] };
    upsertOrgDayMetrics("ent1", "cli-org", record as any);
    const results = getOrgMetrics("cli-org", "2024-01-12", "2024-01-12");
    expect(results).toHaveLength(1);
    expect(results[0].totals_by_cli).toEqual([{ name: "ghcs", total_chats: 8 }]);
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

  it("filters by enterprise slug with aliased buildEnterpriseFilter", () => {
    const summary = getAggregatedDailySummary("2024-01-01", "2024-01-31", ["ent1"]);
    expect(summary.length).toBeGreaterThanOrEqual(1);
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

  it("merges pull_requests across orgs with weightedMedian", () => {
    const pr1 = { total_created: 10, total_reviewed: 5, total_merged: 8, total_suggestions: 3, total_applied_suggestions: 1, total_created_by_copilot: 2, total_reviewed_by_copilot: 1, total_merged_created_by_copilot: 2, total_merged_reviewed_by_copilot: 1, total_copilot_suggestions: 2, total_copilot_applied_suggestions: 1, median_minutes_to_merge: 60, median_minutes_to_merge_copilot_authored: 30, median_minutes_to_merge_copilot_reviewed: 45 };
    const pr2 = { total_created: 6, total_reviewed: 4, total_merged: 4, total_suggestions: 2, total_applied_suggestions: 0, total_created_by_copilot: 1, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 1, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 1, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 120, median_minutes_to_merge_copilot_authored: 90, median_minutes_to_merge_copilot_reviewed: null };
    upsertOrgDayMetrics("ent1", "pr-org1", { day: "2024-02-01", enterprise_id: "ent-123", daily_active_users: 2, weekly_active_users: 4, monthly_active_users: 8, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 10, code_acceptance_activity_count: 5, user_initiated_interaction_count: 20, loc_suggested_to_add_sum: 50, loc_suggested_to_delete_sum: 5, loc_added_sum: 40, loc_deleted_sum: 3, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: pr1 } as any);
    upsertOrgDayMetrics("ent1", "pr-org2", { day: "2024-02-01", enterprise_id: "ent-123", daily_active_users: 1, weekly_active_users: 3, monthly_active_users: 5, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 5, code_acceptance_activity_count: 2, user_initiated_interaction_count: 10, loc_suggested_to_add_sum: 20, loc_suggested_to_delete_sum: 2, loc_added_sum: 15, loc_deleted_sum: 1, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: pr2 } as any);
    const results = getFilteredOrgMetrics(["pr-org1", "pr-org2"], "2024-02-01", "2024-02-01");
    expect(results).toHaveLength(1);
    const pr = results[0].pull_requests!;
    expect(pr.total_created).toBe(16);
    expect(pr.total_merged).toBe(12);
    // weightedMedian: (60*8 + 120*4) / 12 = 80
    expect(pr.median_minutes_to_merge).toBeCloseTo(80, 1);
  });

  it("handles one org with PR and one without", () => {
    upsertOrgDayMetrics("ent1", "pr-org3", { day: "2024-02-02", enterprise_id: "ent-123", daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 1, code_acceptance_activity_count: 0, user_initiated_interaction_count: 1, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] } as any);
    upsertOrgDayMetrics("ent1", "pr-org4", { day: "2024-02-02", enterprise_id: "ent-123", daily_active_users: 2, weekly_active_users: 2, monthly_active_users: 2, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 2, code_acceptance_activity_count: 1, user_initiated_interaction_count: 2, loc_suggested_to_add_sum: 10, loc_suggested_to_delete_sum: 1, loc_added_sum: 8, loc_deleted_sum: 1, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: { total_created: 3, total_reviewed: 2, total_merged: 2, total_suggestions: 1, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 45, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null } } as any);
    const results = getFilteredOrgMetrics(["pr-org3", "pr-org4"], "2024-02-02", "2024-02-02");
    expect(results).toHaveLength(1);
    // First org has no PR, second has PR → copies PR
    expect(results[0].pull_requests).toBeDefined();
    expect(results[0].pull_requests!.total_created).toBe(3);
  });

  it("empty orgSlugs delegates to getAllOrgMetrics", () => {
    const results = getFilteredOrgMetrics([], "2024-01-15", "2024-01-15");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("getAllOrgMetrics merges PR data when first org has no PR", () => {
    upsertOrgDayMetrics("ent1", "allorg-nop", { day: "2024-03-10", enterprise_id: "e1", daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 1, code_acceptance_activity_count: 0, user_initiated_interaction_count: 1, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] } as any);
    upsertOrgDayMetrics("ent1", "allorg-ypr", { day: "2024-03-10", enterprise_id: "e1", daily_active_users: 2, weekly_active_users: 2, monthly_active_users: 2, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 2, code_acceptance_activity_count: 1, user_initiated_interaction_count: 2, loc_suggested_to_add_sum: 10, loc_suggested_to_delete_sum: 0, loc_added_sum: 5, loc_deleted_sum: 0, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: { total_created: 7, total_reviewed: 3, total_merged: 5, total_suggestions: 2, total_applied_suggestions: 1, total_created_by_copilot: 1, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 1, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 1, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 30, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null } } as any);
    const results = getAllOrgMetrics("2024-03-10", "2024-03-10");
    expect(results).toHaveLength(1);
    expect(results[0].pull_requests).toBeDefined();
    expect(results[0].pull_requests!.total_created).toBe(7);
  });

  it("getAllOrgMetrics handles null numeric fields via ?? 0 fallbacks", () => {
    // Insert raw SQL with NULLs to trigger ?? 0 branches in merge logic
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 3, 5, 10, 1, 1, 0, 20, 15, 30, 50, 5, 40, 3, '[]', '[]', '[]', '[]', '[]', NULL, '{}')`)
      .run("ent1", "2024-04-20", "null-org1", "e1");
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', '[]', '[]', '[]', '[]', NULL, '{}')`)
      .run("ent1", "2024-04-20", "null-org2", "e1");
    const results = getAllOrgMetrics("2024-04-20", "2024-04-20");
    const day = results.find(r => r.day === "2024-04-20");
    expect(day).toBeDefined();
    expect(day!.daily_active_users).toBe(3);
  });

  it("getFilteredOrgMetrics handles null numeric fields via ?? 0 fallbacks", () => {
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 5, 8, 12, 2, 2, 1, 30, 20, 40, 60, 10, 50, 5, '[]', '[]', '[]', '[]', '[]', NULL, '{}')`)
      .run("ent1", "2024-04-21", "filt-org1", "e1");
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', '[]', '[]', '[]', '[]', NULL, '{}')`)
      .run("ent1", "2024-04-21", "filt-org2", "e1");
    const results = getFilteredOrgMetrics(["filt-org1", "filt-org2"], "2024-04-21", "2024-04-21");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_users).toBe(5);
  });

  it("weightedMedian averages when both weights are 0 (total_merged=0)", () => {
    const pr0 = { total_created: 0, total_reviewed: 0, total_merged: 0, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 60, median_minutes_to_merge_copilot_authored: 40, median_minutes_to_merge_copilot_reviewed: 20 };
    const pr1 = { total_created: 0, total_reviewed: 0, total_merged: 0, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 80, median_minutes_to_merge_copilot_authored: 60, median_minutes_to_merge_copilot_reviewed: 40 };
    upsertOrgDayMetrics("ent1", "wm-org1", { day: "2024-05-01", enterprise_id: "e1", daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: pr0 } as any);
    upsertOrgDayMetrics("ent1", "wm-org2", { day: "2024-05-01", enterprise_id: "e1", daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: pr1 } as any);
    const results = getAllOrgMetrics("2024-05-01", "2024-05-01");
    const day = results.find(r => r.day === "2024-05-01");
    expect(day!.pull_requests!.median_minutes_to_merge).toBe(70); // (60+80)/2
  });

  it("weightedMedian returns b when a is null (a==null path)", () => {
    // First org has null median_minutes_to_merge, second has value
    const prNullMedian = { total_created: 2, total_reviewed: 1, total_merged: 3, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: null, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null };
    const prWithMedian = { total_created: 4, total_reviewed: 2, total_merged: 5, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 90, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null };
    upsertOrgDayMetrics("ent1", "wm-a-null1", { day: "2024-05-02", enterprise_id: "e1", daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: prNullMedian } as any);
    upsertOrgDayMetrics("ent1", "wm-a-null2", { day: "2024-05-02", enterprise_id: "e1", daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1, monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [], pull_requests: prWithMedian } as any);
    const results = getAllOrgMetrics("2024-05-02", "2024-05-02");
    const day = results.find(r => r.day === "2024-05-02");
    // a==null → returns b (90)
    expect(day!.pull_requests!.median_minutes_to_merge).toBe(90);
    // both null → returns null
    expect(day!.pull_requests!.median_minutes_to_merge_copilot_authored).toBeNull();
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

  it("getLatestSyncDay returns null for unknown scope", () => {
    expect(getLatestSyncDay("ent1", "users", "nonexistent")).toBeNull();
  });

  it("recordSync with null day stores __none__", () => {
    recordSync("ent1", "teams", "all", null, 10);
    expect(isSynced("ent1", "teams", "all", "__none__")).toBe(true);
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

describe("getAllOrgMetrics PR merge with null PR numeric fields", () => {
  it("uses ?? 0 fallback when merging PR fields that are null", () => {
    const prWithNulls = JSON.stringify({ total_created: null, total_reviewed: null, total_merged: null, total_suggestions: null, total_applied_suggestions: null, total_created_by_copilot: null, total_reviewed_by_copilot: null, total_merged_created_by_copilot: null, total_merged_reviewed_by_copilot: null, total_copilot_suggestions: null, total_copilot_applied_suggestions: null, median_minutes_to_merge: null, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null });
    const prValid = JSON.stringify({ total_created: 5, total_reviewed: 3, total_merged: 2, total_suggestions: 1, total_applied_suggestions: 1, total_created_by_copilot: 1, total_reviewed_by_copilot: 1, total_merged_created_by_copilot: 1, total_merged_reviewed_by_copilot: 1, total_copilot_suggestions: 1, total_copilot_applied_suggestions: 1, median_minutes_to_merge: 30, median_minutes_to_merge_copilot_authored: 20, median_minutes_to_merge_copilot_reviewed: 10 });
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 2, 3, 5, 1, 1, 0, 10, 8, 5, 20, 5, 15, 3, '[]', '[]', '[]', '[]', '[]', ?, '{}')`)
      .run("ent1", "2024-06-01", "pr-null-org1", "e1", prValid);
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 1, 2, 4, 0, 0, 0, 5, 3, 2, 10, 2, 8, 1, '[]', '[]', '[]', '[]', '[]', ?, '{}')`)
      .run("ent1", "2024-06-01", "pr-null-org2", "e1", prWithNulls);
    const results = getAllOrgMetrics("2024-06-01", "2024-06-01");
    const day = results.find(r => r.day === "2024-06-01");
    expect(day!.pull_requests!.total_created).toBe(5);
    expect(day!.pull_requests!.total_merged).toBe(2);
  });
});

describe("getFilteredOrgMetrics PR merge with null PR fields", () => {
  it("uses ?? 0 fallback when merging null PR fields in filtered orgs", () => {
    const prWithNulls = JSON.stringify({ total_created: null, total_reviewed: null, total_merged: null, total_suggestions: null, total_applied_suggestions: null, total_created_by_copilot: null, total_reviewed_by_copilot: null, total_merged_created_by_copilot: null, total_merged_reviewed_by_copilot: null, total_copilot_suggestions: null, total_copilot_applied_suggestions: null, median_minutes_to_merge: null, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null });
    const prValid = JSON.stringify({ total_created: 8, total_reviewed: 4, total_merged: 3, total_suggestions: 2, total_applied_suggestions: 2, total_created_by_copilot: 2, total_reviewed_by_copilot: 2, total_merged_created_by_copilot: 2, total_merged_reviewed_by_copilot: 2, total_copilot_suggestions: 2, total_copilot_applied_suggestions: 2, median_minutes_to_merge: 45, median_minutes_to_merge_copilot_authored: 25, median_minutes_to_merge_copilot_reviewed: 15 });
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 3, 4, 6, 1, 1, 0, 15, 10, 8, 30, 8, 20, 4, '[]', '[]', '[]', '[]', '[]', ?, '{}')`)
      .run("ent1", "2024-06-03", "filt-pr-org1", "e1", prValid);
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 2, 3, 5, 0, 0, 0, 8, 5, 3, 15, 4, 10, 2, '[]', '[]', '[]', '[]', '[]', ?, '{}')`)
      .run("ent1", "2024-06-03", "filt-pr-org2", "e1", prWithNulls);
    const results = getFilteredOrgMetrics(["filt-pr-org1", "filt-pr-org2"], "2024-06-03", "2024-06-03");
    expect(results).toHaveLength(1);
    expect(results[0].pull_requests!.total_created).toBe(8);
  });

  it("assigns PRs when first org has none and second has PRs", () => {
    const prValid = JSON.stringify({ total_created: 4, total_reviewed: 2, total_merged: 1, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 50, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null });
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 2, 3, 5, 0, 0, 0, 5, 3, 2, 10, 2, 8, 1, '[]', '[]', '[]', '[]', '[]', NULL, '{}')`)
      .run("ent1", "2024-06-04", "filt-nopr-org1", "e1");
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 3, 4, 6, 1, 1, 0, 10, 7, 5, 20, 5, 15, 3, '[]', '[]', '[]', '[]', '[]', ?, '{}')`)
      .run("ent1", "2024-06-04", "filt-nopr-org2", "e1", prValid);
    const results = getFilteredOrgMetrics(["filt-nopr-org1", "filt-nopr-org2"], "2024-06-04", "2024-06-04");
    expect(results).toHaveLength(1);
    expect(results[0].pull_requests!.total_created).toBe(4);
  });
});

describe("mapDayTotalRow JSON null fallback", () => {
  it("uses || '[]' fallback when JSON columns are NULL in DB", () => {
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, '{}')`)
      .run("ent1", "2024-07-01", "null-json-org", "e1");
    const results = getOrgMetrics("null-json-org", "2024-07-01", "2024-07-01");
    expect(results).toHaveLength(1);
    expect(results[0].totals_by_ide).toEqual([]);
    expect(results[0].totals_by_feature).toEqual([]);
    expect(results[0].totals_by_language_feature).toEqual([]);
    expect(results[0].totals_by_model_feature).toEqual([]);
    expect(results[0].totals_by_language_model).toEqual([]);
  });
});

describe("mapUserRow JSON null fallback", () => {
  it("uses || '[]' fallback when user JSON columns are NULL in DB", () => {
    db.prepare(`INSERT OR REPLACE INTO user_daily_metrics (enterprise_slug, day, enterprise_id, user_id, user_login, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_custom_mode, chat_panel_edit_mode, chat_panel_plan_mode, chat_panel_unknown_mode, used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive, used_copilot_coding_agent, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, totals_by_cli, agent_edit, raw_json) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}')`)
      .run("ent1", "2024-07-01", "e1", 9999, "null-json-user");
    const results = getUserMetricsByLogin("null-json-user", "2024-07-01", "2024-07-01");
    expect(results).toHaveLength(1);
    expect(results[0].totals_by_ide).toEqual([]);
    expect(results[0].totals_by_feature).toEqual([]);
    expect(results[0].totals_by_language_feature).toEqual([]);
    expect(results[0].totals_by_model_feature).toEqual([]);
    expect(results[0].totals_by_language_model).toEqual([]);
    expect(results[0].totals_by_cli).toBeUndefined();
    expect(results[0].agent_edit).toBeUndefined();
  });
});
