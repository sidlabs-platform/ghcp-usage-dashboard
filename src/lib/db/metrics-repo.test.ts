import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";
import type { DayTotal } from "@/lib/types/metrics";

let db: Database;

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
  countEffectiveEnterprises,
  invalidateEnterpriseCountCache,
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
  getUserAiCreditsSummary,
  getUserAiCreditsUsersPaginated,
  getUserAiCreditsTotals,
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

  it("handles null/undefined user_initiated_interaction_count via || 0", () => {
    const features = [
      { feature: "chat_panel_ask_mode", user_initiated_interaction_count: null },
      { feature: "chat_panel_agent_mode", user_initiated_interaction_count: undefined },
    ] as any[];
    const result = extractChatModeCounts(features);
    expect(result.ask).toBe(0);
    expect(result.agent).toBe(0);
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

  it("upsertEnterpriseDayMetrics handles undefined optional fields", () => {
    const minimal = { day: "2024-01-12", enterprise_id: "ent-123", daily_active_users: 1, weekly_active_users: 2, monthly_active_users: 3, monthly_active_agent_users: 0, monthly_active_chat_users: 0, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0 };
    upsertEnterpriseDayMetrics("ent1", minimal as any);
    const results = getEnterpriseMetrics("2024-01-12", "2024-01-12");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_cli_users).toBe(0);
    expect(results[0].totals_by_ide).toEqual([]);
  });

  it("resolveEnterpriseId finds from enterprise metrics", () => {
    upsertEnterpriseDayMetrics("ent1", baseDayTotal as any);
    expect(resolveEnterpriseId(["ent1"])).toBe("ent-123");
  });

  it("resolveEnterpriseId falls back to enterprise_daily_metrics when no user data", () => {
    upsertEnterpriseDayMetrics("ent-only-slug", { ...baseDayTotal, enterprise_id: "ent-only-id" } as any);
    expect(resolveEnterpriseId(["ent-only-slug"])).toBe("ent-only-id");
  });

  it("resolveEnterpriseId returns null when no data", () => {
    expect(resolveEnterpriseId(["nonexistent"])).toBeNull();
  });

  it("hasEnterpriseDataForRange returns true when data exists", () => {
    upsertEnterpriseDayMetrics("ent1", baseDayTotal as any);
    expect(hasEnterpriseDataForRange("ent1", "2024-01-01", "2024-01-31")).toBe(true);
  });

  it("hasEnterpriseDataForRange returns false for empty range", () => {
    expect(hasEnterpriseDataForRange("ent1", "2025-01-01", "2025-01-31")).toBe(false);
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

  it("upsertOrgDayMetrics handles undefined optional JSON fields", () => {
    const minimal = { day: "2024-01-13", enterprise_id: "e1", daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1, monthly_active_agent_users: 0, monthly_active_chat_users: 0, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0 };
    upsertOrgDayMetrics("ent1", "minimal-org", minimal as any);
    const results = getOrgMetrics("minimal-org", "2024-01-13", "2024-01-13");
    expect(results).toHaveLength(1);
    expect(results[0].totals_by_ide).toEqual([]);
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

  it("handles records with no chat mode data (fallback to 0)", () => {
    const records = [{ day: "2024-01-21", enterprise_id: "ent-123", user_id: 50, user_login: "no-chat", code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, used_agent: false, used_chat: false, used_cli: false, used_copilot_code_review_active: false, used_copilot_code_review_passive: false, used_copilot_coding_agent: false, totals_by_ide: [], totals_by_language_feature: [], totals_by_model_feature: [], totals_by_language_model: [] }] as any[];
    const count = batchUpsertUserDayMetrics("ent1", records);
    expect(count).toBe(1);
  });

  it("handles records with all boolean flags true and optional fields", () => {
    const records = [{ day: "2024-01-22", enterprise_id: "ent-123", user_id: 60, user_login: "full-flags", code_generation_activity_count: 1, code_acceptance_activity_count: 1, user_initiated_interaction_count: 1, loc_suggested_to_add_sum: 10, loc_suggested_to_delete_sum: 2, loc_added_sum: 8, loc_deleted_sum: 1, used_agent: true, used_chat: true, used_cli: true, used_copilot_code_review_active: true, used_copilot_code_review_passive: true, used_copilot_coding_agent: true, totals_by_ide: [{ name: "vsc" }], totals_by_feature: [{ feature: "code_completion" }], totals_by_language_feature: [{ lang: "ts" }], totals_by_model_feature: [{ model: "gpt4" }], totals_by_language_model: [{ lang: "ts" }], totals_by_cli: [{ name: "ghcs" }], agent_edit: { total: 5 } }] as any[];
    const count = batchUpsertUserDayMetrics("ent1", records);
    expect(count).toBe(1);
  });

  it("handles records with all JSON fields undefined (|| [] fallback)", () => {
    const records = [{ day: "2024-01-25", enterprise_id: "ent-123", user_id: 70, user_login: "no-json", code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, used_agent: false, used_chat: false, used_cli: false, used_copilot_code_review_active: false, used_copilot_code_review_passive: false, used_copilot_coding_agent: false }] as any[];
    const count = batchUpsertUserDayMetrics("ent1", records);
    expect(count).toBe(1);
    const row = db.prepare("SELECT totals_by_ide, totals_by_feature FROM user_daily_metrics WHERE user_login = 'no-json'").get() as any;
    expect(row.totals_by_ide).toBe("[]");
    expect(row.totals_by_feature).toBe("[]");
  });

  it("returns 0 for empty records array", () => {
    const count = batchUpsertUserDayMetrics("ent1", []);
    expect(count).toBe(0);
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

  it("upsertUserDayMetrics stores true code-review/agent flags and optional fields", () => {
    const record = { day: "2024-01-23", enterprise_id: "ent-123", user_id: 21, user_login: "review-user", code_generation_activity_count: 1, code_acceptance_activity_count: 1, user_initiated_interaction_count: 1, loc_suggested_to_add_sum: 5, loc_suggested_to_delete_sum: 1, loc_added_sum: 4, loc_deleted_sum: 0, used_agent: true, used_chat: true, used_cli: true, used_copilot_code_review_active: true, used_copilot_code_review_passive: true, used_copilot_coding_agent: true, totals_by_ide: [{ name: "vsc" }], totals_by_feature: [{ feature: "code_completion" }], totals_by_language_feature: [{ lang: "ts" }], totals_by_model_feature: [{ model: "gpt4" }], totals_by_language_model: [{ lang: "ts" }], totals_by_cli: [{ name: "ghcs" }], agent_edit: { total: 3 } } as any;
    upsertUserDayMetrics("ent1", record);
    const results = getUserMetricsByLogin("review-user", "2024-01-23", "2024-01-23");
    expect(results).toHaveLength(1);
    expect(results[0].used_copilot_code_review_active).toBe(true);
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

  it("handles weightedMedian when first org has null medians (a==null path)", () => {
    const prNullMedian = JSON.stringify({ total_created: 3, total_reviewed: 2, total_merged: 2, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: null, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null });
    const prWithMedian = JSON.stringify({ total_created: 4, total_reviewed: 3, total_merged: 1, total_suggestions: 1, total_applied_suggestions: 1, total_created_by_copilot: 1, total_reviewed_by_copilot: 1, total_merged_created_by_copilot: 1, total_merged_reviewed_by_copilot: 1, total_copilot_suggestions: 1, total_copilot_applied_suggestions: 1, median_minutes_to_merge: 60, median_minutes_to_merge_copilot_authored: 40, median_minutes_to_merge_copilot_reviewed: 20 });
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 2, 3, 5, 0, 0, 0, 5, 3, 2, 10, 2, 8, 1, '[]', '[]', '[]', '[]', '[]', ?, '{}')`)
      .run("ent1", "2024-06-10", "aaa-first-org", "e1", prNullMedian);
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 3, 4, 6, 1, 1, 0, 10, 8, 5, 20, 5, 15, 3, '[]', '[]', '[]', '[]', '[]', ?, '{}')`)
      .run("ent1", "2024-06-10", "zzz-second-org", "e1", prWithMedian);
    const results = getAllOrgMetrics("2024-06-10", "2024-06-10");
    const day = results.find(r => r.day === "2024-06-10");
    expect(day!.pull_requests!.median_minutes_to_merge).toBe(60);
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

describe("upsertUserDayMetrics with undefined JSON array fields", () => {
  it("uses || [] fallback for totals_by_ide/feature/language_feature/model_feature/language_model", () => {
    upsertUserDayMetrics("ent1", {
      day: "2024-08-01", enterprise_id: "e1", user_id: 7777, user_login: "undefined-json-user",
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: undefined as any, totals_by_feature: undefined as any,
      totals_by_language_feature: undefined as any, totals_by_model_feature: undefined as any,
      totals_by_language_model: undefined as any,
    } as any);
    const rows = getUserMetricsByLogin("undefined-json-user", "2024-08-01", "2024-08-01");
    expect(rows).toHaveLength(1);
    expect(rows[0].totals_by_ide).toEqual([]);
  });
});

describe("resolveEnterpriseId fallback to enterprise_daily_metrics", () => {
  it("returns enterprise_id from enterprise_daily_metrics when user_daily_metrics is empty for slug", () => {
    db.prepare(`INSERT OR REPLACE INTO enterprise_daily_metrics (enterprise_slug, day, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, 0,0,0,0,0,0,0,0,0,0,0,0,0,'[]','[]','[]','[]','[]',NULL,'{}')`)
      .run("fallback-ent", "2024-08-01", "eid-999");
    const result = resolveEnterpriseId(["fallback-ent"]);
    expect(result).toBe("eid-999");
  });
});

describe("getAllOrgMetrics weightedMedian with null median_minutes_to_merge", () => {
  it("handles null median on one org and valid on another (same day)", () => {
    const prWithMedian = JSON.stringify({ total_created: 2, total_reviewed: 1, total_merged: 3, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: 30, median_minutes_to_merge_copilot_authored: null, median_minutes_to_merge_copilot_reviewed: null });
    const prNoMedian = JSON.stringify({ total_created: 1, total_reviewed: 1, total_merged: 2, total_suggestions: 0, total_applied_suggestions: 0, total_created_by_copilot: 0, total_reviewed_by_copilot: 0, total_merged_created_by_copilot: 0, total_merged_reviewed_by_copilot: 0, total_copilot_suggestions: 0, total_copilot_applied_suggestions: 0, median_minutes_to_merge: null, median_minutes_to_merge_copilot_authored: 10, median_minutes_to_merge_copilot_reviewed: null });
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 5,5,5,0,0,0,10,5,0,0,0,0,0,'[]','[]','[]','[]','[]',?,'{}')`).run("ent1", "2024-08-10", "wm-org1", "e1", prWithMedian);
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 3,3,3,0,0,0,5,2,0,0,0,0,0,'[]','[]','[]','[]','[]',?,'{}')`).run("ent1", "2024-08-10", "wm-org2", "e1", prNoMedian);
    const results = getAllOrgMetrics("2024-08-10", "2024-08-10");
    expect(results).toHaveLength(1);
    expect(results[0].pull_requests!.median_minutes_to_merge).toBe(30);
    expect(results[0].pull_requests!.median_minutes_to_merge_copilot_authored).toBe(10);
  });
});

describe("getAllOrgMetrics daily_active_cli_users null fallback", () => {
  it("aggregates correctly when daily_active_cli_users is NULL in DB", () => {
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 2,2,2,0,0,NULL,1,1,0,0,0,0,0,'[]','[]','[]','[]','[]',NULL,'{}')`).run("ent1", "2024-09-01", "cli-null-org1", "e1");
    db.prepare(`INSERT OR REPLACE INTO org_daily_metrics (enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users, monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users, code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count, loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum, totals_by_ide, totals_by_feature, totals_by_language_feature, totals_by_model_feature, totals_by_language_model, pull_requests, raw_json) VALUES (?, ?, ?, ?, 3,3,3,0,0,NULL,2,2,0,0,0,0,0,'[]','[]','[]','[]','[]',NULL,'{}')`).run("ent1", "2024-09-01", "cli-null-org2", "e1");
    const results = getAllOrgMetrics("2024-09-01", "2024-09-01");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_cli_users).toBe(0);
  });
});

describe("enterprise_id fallback for org-only mode", () => {
  it("batchUpsertUserDayMetrics uses enterpriseSlug when enterprise_id is missing", () => {
    const records = [{
      day: "2024-10-01", enterprise_id: undefined, user_id: 8888, user_login: "orgonly-user",
      code_generation_activity_count: 5, code_acceptance_activity_count: 3,
      user_initiated_interaction_count: 2,
      loc_suggested_to_add_sum: 10, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 8, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    }] as any[];
    const count = batchUpsertUserDayMetrics("_org_only", records);
    expect(count).toBe(1);
    const row = db.prepare(
      "SELECT enterprise_id FROM user_daily_metrics WHERE user_login = 'orgonly-user' AND day = '2024-10-01'"
    ).get() as any;
    expect(row.enterprise_id).toBe("_org_only");
  });

  it("upsertUserDayMetrics uses enterpriseSlug when enterprise_id is missing", () => {
    upsertUserDayMetrics("_org_only", {
      day: "2024-10-02", enterprise_id: undefined as any, user_id: 8889, user_login: "orgonly-user2",
      code_generation_activity_count: 1, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    } as any);
    const row = db.prepare(
      "SELECT enterprise_id FROM user_daily_metrics WHERE user_login = 'orgonly-user2' AND day = '2024-10-02'"
    ).get() as any;
    expect(row.enterprise_id).toBe("_org_only");
  });

  it("preserves real enterprise_id when present", () => {
    const records = [{
      day: "2024-10-03", enterprise_id: "real-ent-123", user_id: 8890, user_login: "ent-user",
      code_generation_activity_count: 1, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    }] as any[];
    batchUpsertUserDayMetrics("some-ent", records);
    const row = db.prepare(
      "SELECT enterprise_id FROM user_daily_metrics WHERE user_login = 'ent-user' AND day = '2024-10-03'"
    ).get() as any;
    expect(row.enterprise_id).toBe("real-ent-123");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Multi-enterprise test suite — validates that DAU/WAU/MAU, adoption,
// feature usage, and CLI user counts are correctly deduplicated when
// users appear across multiple enterprises.
// ═══════════════════════════════════════════════════════════════════════

describe("multi-enterprise: countEffectiveEnterprises", () => {
  function insertMinimalUser(day: string, entId: string, entSlug: string, userId: number, login: string) {
    db.prepare(`
      INSERT OR REPLACE INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        code_generation_activity_count, code_acceptance_activity_count,
        user_initiated_interaction_count,
        loc_suggested_to_add_sum, loc_suggested_to_delete_sum,
        loc_added_sum, loc_deleted_sum,
        chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_custom_mode,
        chat_panel_edit_mode, chat_panel_plan_mode, chat_panel_unknown_mode,
        used_agent, used_chat, used_cli,
        used_copilot_code_review_active, used_copilot_code_review_passive, used_copilot_coding_agent,
        totals_by_ide, totals_by_feature, totals_by_language_feature,
        totals_by_model_feature, totals_by_language_model, totals_by_cli
      ) VALUES (?, ?, ?, ?, ?, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,'[]','[]','[]','[]','[]',null)
    `).run(day, entId, entSlug, userId, login);
  }

  beforeEach(() => {
    db.exec("DELETE FROM user_daily_metrics");
    db.exec("DELETE FROM enterprise_daily_metrics");
    invalidateEnterpriseCountCache();
  });

  it("returns 0 when no data exists", () => {
    expect(countEffectiveEnterprises()).toBe(0);
  });

  it("returns 1 for single enterprise", () => {
    insertMinimalUser("2025-06-01", "ent-a", "acme", 1, "alice");
    expect(countEffectiveEnterprises()).toBe(1);
  });

  it("returns 2 for two distinct enterprises", () => {
    insertMinimalUser("2025-06-01", "ent-a", "acme", 1, "alice");
    insertMinimalUser("2025-06-01", "ent-b", "globex", 2, "bob");
    expect(countEffectiveEnterprises()).toBe(2);
  });

  it("filters by enterprise slugs when provided", () => {
    insertMinimalUser("2025-06-01", "ent-a", "acme", 1, "alice");
    insertMinimalUser("2025-06-01", "ent-b", "globex", 2, "bob");
    expect(countEffectiveEnterprises(["acme"])).toBe(1);
    expect(countEffectiveEnterprises(["acme", "globex"])).toBe(2);
    expect(countEffectiveEnterprises()).toBe(2);
  });

  it("counts org-only enterprises that have no enterprise_daily_metrics rows", () => {
    // Enterprise A: full mode (has both enterprise_daily_metrics and user data)
    insertMinimalUser("2025-06-01", "ent-a", "acme", 1, "alice");
    upsertEnterpriseDayMetrics("acme", {
      day: "2025-06-01", enterprise_id: "ent-a", daily_active_users: 1,
      weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    } as any);

    // Enterprise B: org-only mode (user data exists, but NO enterprise_daily_metrics)
    insertMinimalUser("2025-06-01", "ent-b", "globex", 2, "bob");

    // Must detect 2 enterprises even though enterprise_daily_metrics only has 1
    expect(countEffectiveEnterprises()).toBe(2);
  });
});

describe("multi-enterprise: getAggregatedDailySummary deduplication", () => {
  // Insert multi-enterprise user data where some users overlap
  beforeEach(() => {
    db.exec("DELETE FROM user_daily_metrics");

    const insert = db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        code_generation_activity_count, code_acceptance_activity_count,
        user_initiated_interaction_count,
        loc_suggested_to_add_sum, loc_suggested_to_delete_sum,
        loc_added_sum, loc_deleted_sum,
        chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_custom_mode,
        chat_panel_edit_mode, chat_panel_plan_mode, chat_panel_unknown_mode,
        used_agent, used_chat, used_cli,
        used_copilot_code_review_active, used_copilot_code_review_passive, used_copilot_coding_agent,
        totals_by_ide, totals_by_feature, totals_by_language_feature,
        totals_by_model_feature, totals_by_language_model, totals_by_cli
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Enterprise A: alice (user_id=1), bob (user_id=2)
    // Enterprise B: alice (user_id=1), charlie (user_id=3)
    // alice is in BOTH enterprises on the same day

    // Ent-A, Day 2025-07-01: alice (agent=1, chat=1, cli=1)
    insert.run("2025-07-01", "ent-a", "acme", 1, "alice",
      20, 15, 30, 100, 0, 80, 5, 0, 5, 0, 3, 0, 0, 1, 1, 1, 0, 0, 0,
      "[]", "[]", "[]", "[]", "[]", null);

    // Ent-A, Day 2025-07-01: bob (agent=0, chat=1, cli=0)
    insert.run("2025-07-01", "ent-a", "acme", 2, "bob",
      10, 8, 15, 50, 0, 40, 2, 0, 3, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
      "[]", "[]", "[]", "[]", "[]", null);

    // Ent-B, Day 2025-07-01: alice (agent=1, chat=1, cli=1) — same user, different enterprise
    insert.run("2025-07-01", "ent-b", "globex", 1, "alice",
      15, 10, 20, 80, 0, 60, 3, 0, 4, 0, 2, 0, 0, 1, 1, 1, 0, 0, 0,
      "[]", "[]", "[]", "[]", "[]", null);

    // Ent-B, Day 2025-07-01: charlie (agent=1, chat=0, cli=0)
    insert.run("2025-07-01", "ent-b", "globex", 3, "charlie",
      5, 3, 10, 30, 0, 20, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
      "[]", "[]", "[]", "[]", "[]", null);

    // Day 2 — only alice in Ent-A (to test rolling windows)
    insert.run("2025-07-02", "ent-a", "acme", 1, "alice",
      18, 12, 25, 90, 0, 70, 4, 0, 6, 0, 4, 0, 0, 1, 1, 0, 0, 0, 0,
      "[]", "[]", "[]", "[]", "[]", null);
  });

  it("DAU counts distinct users across enterprises (no double-counting)", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-01");
    expect(summary).toHaveLength(1);
    // 3 distinct users: alice, bob, charlie (alice NOT counted twice)
    expect(summary[0].daily_active_users).toBe(3);
  });

  it("WAU rolling window deduplicates users across enterprises", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-02");
    expect(summary).toHaveLength(2);
    // Day 1: WAU should be 3 (alice, bob, charlie in 7-day window)
    expect(summary[0].weekly_active_users).toBe(3);
    // Day 2: WAU should still be 3 (alice + bob + charlie within 7-day window)
    expect(summary[1].weekly_active_users).toBe(3);
  });

  it("MAU rolling window deduplicates users across enterprises", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-02");
    // Day 2: MAU should be 3 (all users within 30-day window)
    expect(summary[1].monthly_active_users).toBe(3);
  });

  it("CLI user count deduplicates across enterprises (no SUM inflation)", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-01");
    // Only alice has used_cli=1 (in both enterprises) — should count as 1, not 2
    expect(summary[0].daily_active_cli_users).toBe(1);
  });

  it("agent user count deduplicates across enterprises", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-01");
    // alice (both enterprises) + charlie = 2 distinct agent users, NOT 3
    expect(summary[0].agent_users).toBe(2);
  });

  it("chat user count deduplicates across enterprises", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-01");
    // alice (both enterprises) + bob = 2 distinct chat users, NOT 3
    expect(summary[0].chat_users).toBe(2);
  });

  it("activity counts are summed across all rows (additive metrics)", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-01");
    // code_generation: 20 + 10 + 15 + 5 = 50 (summed, not deduplicated)
    expect(summary[0].code_generation_activity_count).toBe(50);
    expect(summary[0].code_acceptance_activity_count).toBe(36); // 15+8+10+3
    expect(summary[0].loc_added_sum).toBe(200); // 80+40+60+20
  });

  it("enterprise slug filter scopes correctly in multi-enterprise", () => {
    // Filter to only acme → alice + bob
    const acmeOnly = getAggregatedDailySummary("2025-07-01", "2025-07-01", ["acme"]);
    expect(acmeOnly).toHaveLength(1);
    expect(acmeOnly[0].daily_active_users).toBe(2);
    expect(acmeOnly[0].daily_active_cli_users).toBe(1); // alice
    expect(acmeOnly[0].agent_users).toBe(1); // alice
    expect(acmeOnly[0].chat_users).toBe(2); // alice + bob

    // Filter to only globex → alice + charlie
    const globexOnly = getAggregatedDailySummary("2025-07-01", "2025-07-01", ["globex"]);
    expect(globexOnly).toHaveLength(1);
    expect(globexOnly[0].daily_active_users).toBe(2);
    expect(globexOnly[0].daily_active_cli_users).toBe(1); // alice
    expect(globexOnly[0].agent_users).toBe(2); // alice + charlie
    expect(globexOnly[0].chat_users).toBe(1); // alice

    // Combined → 3 distinct users
    const both = getAggregatedDailySummary("2025-07-01", "2025-07-01", ["acme", "globex"]);
    expect(both).toHaveLength(1);
    expect(both[0].daily_active_users).toBe(3);
  });

  it("DAU across multi-day range with overlapping user", () => {
    const summary = getAggregatedDailySummary("2025-07-01", "2025-07-02");
    expect(summary).toHaveLength(2);
    // Day 1: 3 distinct (alice, bob, charlie)
    expect(summary[0].daily_active_users).toBe(3);
    // Day 2: 1 distinct (alice only)
    expect(summary[1].daily_active_users).toBe(1);
  });
});

describe("multi-enterprise: getEnterpriseMetrics returns duplicate days", () => {
  // This test documents the known limitation that enterprise-level data
  // produces duplicate day entries for multi-enterprise — which is why
  // the overview route must fall through to user-level aggregation.
  beforeEach(() => {
    db.exec("DELETE FROM enterprise_daily_metrics");
  });

  it("returns separate rows per enterprise for same day", () => {
    upsertEnterpriseDayMetrics("acme", {
      day: "2025-07-01", enterprise_id: "ent-a", daily_active_users: 50,
      weekly_active_users: 120, monthly_active_users: 200,
      monthly_active_agent_users: 10, monthly_active_chat_users: 40, daily_active_cli_users: 5,
      code_generation_activity_count: 500, code_acceptance_activity_count: 350,
      user_initiated_interaction_count: 1000,
      loc_suggested_to_add_sum: 2000, loc_suggested_to_delete_sum: 100,
      loc_added_sum: 1500, loc_deleted_sum: 80,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    } as any);
    upsertEnterpriseDayMetrics("globex", {
      day: "2025-07-01", enterprise_id: "ent-b", daily_active_users: 30,
      weekly_active_users: 80, monthly_active_users: 150,
      monthly_active_agent_users: 5, monthly_active_chat_users: 20, daily_active_cli_users: 3,
      code_generation_activity_count: 300, code_acceptance_activity_count: 200,
      user_initiated_interaction_count: 600,
      loc_suggested_to_add_sum: 1200, loc_suggested_to_delete_sum: 50,
      loc_added_sum: 900, loc_deleted_sum: 40,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    } as any);

    const metrics = getEnterpriseMetrics("2025-07-01", "2025-07-01");
    // Two rows for the same day — one per enterprise
    expect(metrics).toHaveLength(2);
    expect(metrics[0].day).toBe("2025-07-01");
    expect(metrics[1].day).toBe("2025-07-01");
    // Cannot simply sum DAU (users may overlap)
    // Cannot take last row (loses first enterprise's data)
    // This is why multi-enterprise must use user-level aggregation
  });

  it("single enterprise returns one row per day", () => {
    upsertEnterpriseDayMetrics("acme", {
      day: "2025-07-01", enterprise_id: "ent-a", daily_active_users: 50,
      weekly_active_users: 120, monthly_active_users: 200,
      monthly_active_agent_users: 10, monthly_active_chat_users: 40, daily_active_cli_users: 5,
      code_generation_activity_count: 500, code_acceptance_activity_count: 350,
      user_initiated_interaction_count: 1000,
      loc_suggested_to_add_sum: 2000, loc_suggested_to_delete_sum: 100,
      loc_added_sum: 1500, loc_deleted_sum: 80,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    } as any);

    const metrics = getEnterpriseMetrics("2025-07-01", "2025-07-01");
    expect(metrics).toHaveLength(1);
    expect(metrics[0].daily_active_users).toBe(50);
  });
});

describe("ai_adoption_phase and totals_by_ai_adoption_phase", () => {
  beforeEach(() => {
    db.exec("DELETE FROM enterprise_daily_metrics");
    db.exec("DELETE FROM user_daily_metrics");
    invalidateEnterpriseCountCache();
  });

  it("stores and retrieves totals_by_ai_adoption_phase on enterprise metrics", () => {
    const phases = [
      { phase: 0, label: "No cohort", version: "v1", engaged_users: 10, user_initiated_interaction_avg: 1.5, code_generation_activity_avg: 2.0, code_acceptance_activity_avg: 1.0, loc_added_avg: 50, loc_deleted_avg: 5, pull_requests_created_avg: 0.1, pull_requests_merged_avg: 0.05, pull_requests_reviewed_avg: 0.2, median_minutes_to_merge_avg: null, total_pull_requests_merged: 3 },
      { phase: 1, label: "Code first", version: "v1", engaged_users: 30, user_initiated_interaction_avg: 5.0, code_generation_activity_avg: 8.0, code_acceptance_activity_avg: 6.0, loc_added_avg: 200, loc_deleted_avg: 20, pull_requests_created_avg: 0.5, pull_requests_merged_avg: 0.3, pull_requests_reviewed_avg: 1.0, median_minutes_to_merge_avg: 45, total_pull_requests_merged: 42 },
    ];
    upsertEnterpriseDayMetrics("ent1", {
      day: "2026-06-01", enterprise_id: "ent-123",
      daily_active_users: 40, weekly_active_users: 100, monthly_active_users: 150,
      monthly_active_agent_users: 5, monthly_active_chat_users: 30, daily_active_cli_users: 2,
      code_generation_activity_count: 200, code_acceptance_activity_count: 150,
      user_initiated_interaction_count: 500,
      loc_suggested_to_add_sum: 1000, loc_suggested_to_delete_sum: 50,
      loc_added_sum: 800, loc_deleted_sum: 40,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      totals_by_ai_adoption_phase: phases,
    } as any);

    const results = getEnterpriseMetrics("2026-06-01", "2026-06-01");
    expect(results).toHaveLength(1);
    expect(results[0].totals_by_ai_adoption_phase).toHaveLength(2);
    expect(results[0].totals_by_ai_adoption_phase![0].phase).toBe(0);
    expect(results[0].totals_by_ai_adoption_phase![0].label).toBe("No cohort");
    expect(results[0].totals_by_ai_adoption_phase![0].engaged_users).toBe(10);
    expect(results[0].totals_by_ai_adoption_phase![0].total_pull_requests_merged).toBe(3);
    expect(results[0].totals_by_ai_adoption_phase![1].phase).toBe(1);
    expect(results[0].totals_by_ai_adoption_phase![1].median_minutes_to_merge_avg).toBe(45);
    expect(results[0].totals_by_ai_adoption_phase![1].total_pull_requests_merged).toBe(42);
  });

  it("returns empty array for totals_by_ai_adoption_phase when field is omitted (serialized as '[]')", () => {
    upsertEnterpriseDayMetrics("ent1", {
      day: "2026-06-02", enterprise_id: "ent-123",
      daily_active_users: 5, weekly_active_users: 10, monthly_active_users: 20,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0, daily_active_cli_users: 0,
      code_generation_activity_count: 10, code_acceptance_activity_count: 5,
      user_initiated_interaction_count: 20,
      loc_suggested_to_add_sum: 100, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 80, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    } as any);

    const results = getEnterpriseMetrics("2026-06-02", "2026-06-02");
    expect(results).toHaveLength(1);
    // upsert serializes undefined as '[]', so the column is '[]', parsed to empty array
    expect(results[0].totals_by_ai_adoption_phase).toEqual([]);
  });

  it("stores and retrieves ai_adoption_phase on user metrics via batchUpsert", () => {
    const records = [{
      day: "2026-06-01", enterprise_id: "ent-123", user_id: 100, user_login: "cohort-user",
      code_generation_activity_count: 5, code_acceptance_activity_count: 3,
      user_initiated_interaction_count: 10,
      loc_suggested_to_add_sum: 50, loc_suggested_to_delete_sum: 5,
      loc_added_sum: 40, loc_deleted_sum: 2,
      used_agent: true, used_chat: true, used_cli: false,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      ai_adoption_phase: { phase: 2, label: "Agent first", version: "v1" },
    }] as any[];
    batchUpsertUserDayMetrics("ent1", records);

    const row = db.prepare(
      "SELECT ai_adoption_phase FROM user_daily_metrics WHERE user_login = 'cohort-user'"
    ).get() as any;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row.ai_adoption_phase);
    expect(parsed.phase).toBe(2);
    expect(parsed.label).toBe("Agent first");
    expect(parsed.version).toBe("v1");
  });

  it("stores NULL ai_adoption_phase when field is not provided", () => {
    const records = [{
      day: "2026-06-01", enterprise_id: "ent-123", user_id: 101, user_login: "no-cohort-user",
      code_generation_activity_count: 1, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    }] as any[];
    batchUpsertUserDayMetrics("ent1", records);

    const row = db.prepare(
      "SELECT ai_adoption_phase FROM user_daily_metrics WHERE user_login = 'no-cohort-user'"
    ).get() as any;
    expect(row.ai_adoption_phase).toBeNull();
  });

  it("mapUserRow parses ai_adoption_phase from stored JSON", () => {
    const records = [{
      day: "2026-06-03", enterprise_id: "ent-123", user_id: 102, user_login: "mapped-user",
      code_generation_activity_count: 1, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      ai_adoption_phase: { phase: 3, label: "Multi-agent", version: "v1" },
    }] as any[];
    batchUpsertUserDayMetrics("ent1", records);

    const results = getUserMetricsByLogin("mapped-user", "2026-06-03", "2026-06-03");
    expect(results).toHaveLength(1);
    expect(results[0].ai_adoption_phase).toBeDefined();
    expect(results[0].ai_adoption_phase!.phase).toBe(3);
    expect(results[0].ai_adoption_phase!.label).toBe("Multi-agent");
  });

  it("mapUserRow returns undefined ai_adoption_phase when column is NULL", () => {
    const records = [{
      day: "2026-06-04", enterprise_id: "ent-123", user_id: 103, user_login: "null-phase-user",
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      used_copilot_code_review_active: false, used_copilot_code_review_passive: false,
      used_copilot_coding_agent: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    }] as any[];
    batchUpsertUserDayMetrics("ent1", records);

    const results = getUserMetricsByLogin("null-phase-user", "2026-06-04", "2026-06-04");
    expect(results).toHaveLength(1);
    expect(results[0].ai_adoption_phase).toBeUndefined();
  });
});

describe("ai_credits_used", () => {
  beforeEach(() => {
    db.exec("DELETE FROM user_daily_metrics");
    invalidateEnterpriseCountCache();
  });

  it("stores, retrieves, and summarizes per-user AI credits from usage metrics", () => {
    batchUpsertUserDayMetrics("ent1", [
      {
        day: "2026-06-19", enterprise_id: "ent-123", user_id: 201, user_login: "octo",
        code_generation_activity_count: 2, code_acceptance_activity_count: 1,
        user_initiated_interaction_count: 3,
        loc_suggested_to_add_sum: 10, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 8, loc_deleted_sum: 0,
        used_agent: false, used_chat: true, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 12.5,
      },
      {
        day: "2026-06-20", enterprise_id: "ent-123", user_id: 201, user_login: "octo",
        code_generation_activity_count: 1, code_acceptance_activity_count: 1,
        user_initiated_interaction_count: 2,
        loc_suggested_to_add_sum: 5, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 5, loc_deleted_sum: 0,
        used_agent: true, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 7.25,
      },
      {
        day: "2026-06-20", enterprise_id: "ent-123", user_id: 202, user_login: "mona",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 1,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: true, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 3,
      },
    ]);

    const metrics = getUserMetricsByLogin("octo", "2026-06-19", "2026-06-20");
    expect(metrics.map((m) => m.ai_credits_used)).toEqual([12.5, 7.25]);

    const summary = getUserAiCreditsSummary("2026-06-19", "2026-06-20");
    expect(summary).toEqual([
      {
        user_login: "octo",
        total_ai_credits_used: 19.75,
        active_days: 2,
        avg_daily_ai_credits: 9.875,
        last_active_day: "2026-06-20",
      },
      {
        user_login: "mona",
        total_ai_credits_used: 3,
        active_days: 1,
        avg_daily_ai_credits: 3,
        last_active_day: "2026-06-20",
      },
    ]);
  });

  it("computes AI credit KPI totals in SQL without returning every user row", () => {
    batchUpsertUserDayMetrics("ent1", [
      {
        day: "2026-06-19", enterprise_id: "ent-123", user_id: 301, user_login: "top",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 10,
      },
      {
        day: "2026-06-19", enterprise_id: "ent-123", user_id: 302, user_login: "second",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 4,
      },
      {
        day: "2026-06-19", enterprise_id: "ent-123", user_id: 303, user_login: "zero",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 0,
      },
    ]);

    expect(getUserAiCreditsTotals("2026-06-19", "2026-06-20")).toEqual({
      total_ai_credits_used: 14,
      tracked_users: 2,
      top_user_login: "top",
      top_user_ai_credits_used: 10,
    });
    expect(getUserAiCreditsTotals("2026-06-19", "2026-06-20", { search: "sec" })).toEqual({
      total_ai_credits_used: 4,
      tracked_users: 1,
      top_user_login: "second",
      top_user_ai_credits_used: 4,
    });
    expect(getUserAiCreditsTotals("2026-06-19", "2026-06-20", { search: "%" })).toEqual({
      total_ai_credits_used: 0,
      tracked_users: 0,
      top_user_login: "N/A",
      top_user_ai_credits_used: 0,
    });
    expect(getUserAiCreditsSummary("2026-06-19", "2026-06-20", undefined, undefined, 1)).toHaveLength(1);
  });

  it("returns paginated AI credit users with search and safe sorting", () => {
    batchUpsertUserDayMetrics("ent1", [
      {
        day: "2026-07-10", enterprise_id: "ent-123", user_id: 401, user_login: "octo",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 5,
      },
      {
        day: "2026-07-11", enterprise_id: "ent-123", user_id: 401, user_login: "octo",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 15,
      },
      {
        day: "2026-07-10", enterprise_id: "ent-123", user_id: 402, user_login: "mona",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 8,
      },
      {
        day: "2026-07-10", enterprise_id: "ent-123", user_id: 403, user_login: "zero",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        ai_credits_used: 0,
      },
    ]);

    const firstPage = getUserAiCreditsUsersPaginated(
      "2026-07-10",
      "2026-07-11",
      1,
      1,
      "avg_daily_ai_credits",
      "asc",
    );
    expect(firstPage.total).toBe(2);
    expect(firstPage.users).toEqual([
      {
        user_login: "mona",
        total_ai_credits_used: 8,
        active_days: 1,
        avg_daily_ai_credits: 8,
        last_active_day: "2026-07-10",
      },
    ]);

    const searched = getUserAiCreditsUsersPaginated(
      "2026-07-10",
      "2026-07-11",
      1,
      25,
      "last_active_day",
      "desc",
      "oct",
    );
    expect(searched.total).toBe(1);
    expect(searched.users[0]).toMatchObject({
      user_login: "octo",
      total_ai_credits_used: 20,
      active_days: 2,
      avg_daily_ai_credits: 10,
      last_active_day: "2026-07-11",
    });
  });
});

describe("Copilot App usage metrics", () => {
  const SAMPLE_TOTALS_BY_COPILOT_APP = {
    session_count: 2,
    request_count: 6,
    prompt_count: 3,
    token_usage: {
      output_tokens_sum: 6200,
      prompt_tokens_sum: 8600,
      avg_tokens_per_request: 2466.67,
    },
  };

  beforeEach(() => {
    db.exec("DELETE FROM enterprise_daily_metrics");
    db.exec("DELETE FROM org_daily_metrics");
    db.exec("DELETE FROM user_daily_metrics");
    invalidateEnterpriseCountCache();
  });

  it("stores and retrieves daily_active_copilot_app_users and totals_by_copilot_app on enterprise metrics", () => {
    upsertEnterpriseDayMetrics("ent1", {
      day: "2026-08-01", enterprise_id: "ent-123",
      daily_active_users: 40, weekly_active_users: 100, monthly_active_users: 150,
      monthly_active_agent_users: 5, monthly_active_chat_users: 30,
      code_generation_activity_count: 200, code_acceptance_activity_count: 150,
      user_initiated_interaction_count: 500,
      loc_suggested_to_add_sum: 1000, loc_suggested_to_delete_sum: 50,
      loc_added_sum: 800, loc_deleted_sum: 40,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 4,
      totals_by_copilot_app: SAMPLE_TOTALS_BY_COPILOT_APP,
    });

    const results = getEnterpriseMetrics("2026-08-01", "2026-08-01");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBe(4);
    expect(results[0].totals_by_copilot_app).toEqual(SAMPLE_TOTALS_BY_COPILOT_APP);
  });

  it("stores NULL daily_active_copilot_app_users and undefined totals_by_copilot_app when omitted on enterprise metrics", () => {
    upsertEnterpriseDayMetrics("ent1", {
      day: "2026-08-02", enterprise_id: "ent-123",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0,
      loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    });

    const results = getEnterpriseMetrics("2026-08-02", "2026-08-02");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBeNull();
    expect(results[0].totals_by_copilot_app).toBeUndefined();
  });

  it("stores and retrieves daily_active_copilot_app_users and totals_by_copilot_app on organization metrics", () => {
    upsertOrgDayMetrics("ent1", "my-org", {
      day: "2026-08-03", enterprise_id: "ent-123",
      daily_active_users: 10, weekly_active_users: 30, monthly_active_users: 50,
      monthly_active_agent_users: 5, monthly_active_chat_users: 8,
      code_generation_activity_count: 100, code_acceptance_activity_count: 80,
      user_initiated_interaction_count: 200, loc_suggested_to_add_sum: 500,
      loc_suggested_to_delete_sum: 50, loc_added_sum: 400, loc_deleted_sum: 80,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 2,
      totals_by_copilot_app: SAMPLE_TOTALS_BY_COPILOT_APP,
    });

    const results = getOrgMetrics("my-org", "2026-08-03", "2026-08-03");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBe(2);
    expect(results[0].totals_by_copilot_app).toEqual(SAMPLE_TOTALS_BY_COPILOT_APP);
  });

  it("stores NULL daily_active_copilot_app_users and undefined totals_by_copilot_app when omitted on organization metrics", () => {
    upsertOrgDayMetrics("ent1", "minimal-app-org", {
      day: "2026-08-04", enterprise_id: "ent-123",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    });

    const results = getOrgMetrics("minimal-app-org", "2026-08-04", "2026-08-04");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBeNull();
    expect(results[0].totals_by_copilot_app).toBeUndefined();
  });

  it("upserts and retrieves used_copilot_app=true and totals_by_copilot_app for a single user", () => {
    upsertUserDayMetrics("ent1", {
      day: "2026-08-05", enterprise_id: "ent-123", user_id: 500, user_login: "app-user",
      code_generation_activity_count: 1, code_acceptance_activity_count: 1,
      user_initiated_interaction_count: 1, loc_suggested_to_add_sum: 5,
      loc_suggested_to_delete_sum: 1, loc_added_sum: 4, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      used_copilot_app: true,
      totals_by_copilot_app: SAMPLE_TOTALS_BY_COPILOT_APP,
    });

    const results = getUserMetricsByLogin("app-user", "2026-08-05", "2026-08-05");
    expect(results).toHaveLength(1);
    expect(results[0].used_copilot_app).toBe(true);
    expect(results[0].totals_by_copilot_app).toEqual(SAMPLE_TOTALS_BY_COPILOT_APP);
  });

  it("upserts and retrieves used_copilot_app=false distinctly from an unset (null) value", () => {
    upsertUserDayMetrics("ent1", {
      day: "2026-08-06", enterprise_id: "ent-123", user_id: 501, user_login: "app-user-false",
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      used_copilot_app: false,
    });
    upsertUserDayMetrics("ent1", {
      day: "2026-08-06", enterprise_id: "ent-123", user_id: 502, user_login: "app-user-unset",
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      used_agent: false, used_chat: false, used_cli: false,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
    });

    const falseResult = getUserMetricsByLogin("app-user-false", "2026-08-06", "2026-08-06");
    const unsetResult = getUserMetricsByLogin("app-user-unset", "2026-08-06", "2026-08-06");
    expect(falseResult[0].used_copilot_app).toBe(false);
    expect(unsetResult[0].used_copilot_app).toBeNull();
  });

  it("batch-upserts and retrieves used_copilot_app and totals_by_copilot_app for multiple users", () => {
    batchUpsertUserDayMetrics("ent1", [
      {
        day: "2026-08-07", enterprise_id: "ent-123", user_id: 510, user_login: "batch-app-true",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
        loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
        used_copilot_app: true,
        totals_by_copilot_app: SAMPLE_TOTALS_BY_COPILOT_APP,
      },
      {
        day: "2026-08-07", enterprise_id: "ent-123", user_id: 511, user_login: "batch-app-unset",
        code_generation_activity_count: 0, code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
        loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
        used_agent: false, used_chat: false, used_cli: false,
        totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
        totals_by_model_feature: [], totals_by_language_model: [],
      },
    ]);

    const trueResult = getUserMetricsByLogin("batch-app-true", "2026-08-07", "2026-08-07");
    const unsetResult = getUserMetricsByLogin("batch-app-unset", "2026-08-07", "2026-08-07");
    expect(trueResult[0].used_copilot_app).toBe(true);
    expect(trueResult[0].totals_by_copilot_app).toEqual(SAMPLE_TOTALS_BY_COPILOT_APP);
    expect(unsetResult[0].used_copilot_app).toBeNull();
    expect(unsetResult[0].totals_by_copilot_app).toBeUndefined();
  });
});

describe("getAllOrgMetrics / getFilteredOrgMetrics sum daily_active_copilot_app_users across orgs", () => {
  it("getAllOrgMetrics sums daily_active_copilot_app_users across multiple org rows for the same day", () => {
    upsertOrgDayMetrics("ent1", "app-org1", {
      day: "2026-08-08", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 3,
    } as DayTotal);
    upsertOrgDayMetrics("ent1", "app-org2", {
      day: "2026-08-08", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 5,
    } as DayTotal);

    const results = getAllOrgMetrics("2026-08-08", "2026-08-08");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBe(8);
  });

  it("getFilteredOrgMetrics sums daily_active_copilot_app_users across multiple filtered org rows for the same day", () => {
    upsertOrgDayMetrics("ent1", "filt-app-org1", {
      day: "2026-08-09", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 2,
    } as DayTotal);
    upsertOrgDayMetrics("ent1", "filt-app-org2", {
      day: "2026-08-09", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 7,
    } as DayTotal);
    // An unrelated org on the same day must not be included once filtered.
    upsertOrgDayMetrics("ent1", "filt-app-org3-excluded", {
      day: "2026-08-09", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 100,
    } as DayTotal);

    const results = getFilteredOrgMetrics(["filt-app-org1", "filt-app-org2"], "2026-08-09", "2026-08-09");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBe(9);
  });

  it("getAllOrgMetrics treats a NULL daily_active_copilot_app_users on one org row as 0 when summing (null + 6 = 6)", () => {
    upsertOrgDayMetrics("ent1", "app-org-null1", {
      day: "2026-08-10", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      // daily_active_copilot_app_users omitted -> stored as NULL
    } as DayTotal);
    upsertOrgDayMetrics("ent1", "app-org-null2", {
      day: "2026-08-10", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      daily_active_copilot_app_users: 6,
    } as DayTotal);

    const results = getAllOrgMetrics("2026-08-10", "2026-08-10");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBe(6);
  });

  it("getAllOrgMetrics keeps daily_active_copilot_app_users null when every org row for the day is NULL", () => {
    upsertOrgDayMetrics("ent1", "app-org-allnull1", {
      day: "2026-08-11", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      // daily_active_copilot_app_users omitted -> stored as NULL
    } as DayTotal);
    upsertOrgDayMetrics("ent1", "app-org-allnull2", {
      day: "2026-08-11", enterprise_id: "e1",
      daily_active_users: 1, weekly_active_users: 1, monthly_active_users: 1,
      monthly_active_agent_users: 0, monthly_active_chat_users: 0,
      code_generation_activity_count: 0, code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 0, loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
      totals_by_ide: [], totals_by_feature: [], totals_by_language_feature: [],
      totals_by_model_feature: [], totals_by_language_model: [],
      // daily_active_copilot_app_users omitted -> stored as NULL
    } as DayTotal);

    const results = getAllOrgMetrics("2026-08-11", "2026-08-11");
    expect(results).toHaveLength(1);
    expect(results[0].daily_active_copilot_app_users).toBeNull();
  });
});
