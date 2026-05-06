import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  getChatModeSums,
  getAdoptionStats,
  getUserSummaries,
  getUserSummariesPaginated,
  getAdoptionDailyTrend,
  getActiveUsersDailyTrend,
  getCompletionTotals,
  getFeatureBreakdown,
  getModelBreakdown,
} from "./aggregation-queries";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
  const summarySchemaPath = path.join(process.cwd(), "src", "lib", "db", "summary-schema.sql");
  db.exec(fs.readFileSync(summarySchemaPath, "utf-8"));
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM user_daily_metrics");
});

function insertMetric(overrides: Partial<Record<string, unknown>> = {}) {
  const defaults = {
    day: "2024-01-10",
    enterprise_id: "ent1",
    enterprise_slug: "ent1",
    user_id: 1,
    user_login: "user1",
    code_generation_activity_count: 10,
    code_acceptance_activity_count: 7,
    user_initiated_interaction_count: 5,
    loc_suggested_to_add_sum: 20,
    loc_added_sum: 15,
    loc_deleted_sum: 3,
    chat_panel_agent_mode: 2,
    chat_panel_ask_mode: 3,
    chat_panel_edit_mode: 1,
    chat_panel_plan_mode: 0,
    chat_panel_custom_mode: 0,
    chat_panel_unknown_mode: 0,
    used_agent: 1,
    used_chat: 1,
    used_cli: 0,
    used_copilot_code_review_active: 0,
    used_copilot_code_review_passive: 0,
    used_copilot_coding_agent: 0,
  };
  const m = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_added_sum, loc_deleted_sum,
      chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_edit_mode, chat_panel_plan_mode,
      chat_panel_custom_mode, chat_panel_unknown_mode,
      used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive, used_copilot_coding_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.day, m.enterprise_id, m.enterprise_slug, m.user_id, m.user_login,
    m.code_generation_activity_count, m.code_acceptance_activity_count, m.user_initiated_interaction_count,
    m.loc_suggested_to_add_sum, m.loc_added_sum, m.loc_deleted_sum,
    m.chat_panel_agent_mode, m.chat_panel_ask_mode, m.chat_panel_edit_mode, m.chat_panel_plan_mode,
    m.chat_panel_custom_mode, m.chat_panel_unknown_mode,
    m.used_agent, m.used_chat, m.used_cli, m.used_copilot_code_review_active, m.used_copilot_code_review_passive, m.used_copilot_coding_agent,
  );
}

describe("getChatModeSums", () => {
  it("returns zeros for empty data", () => {
    const result = getChatModeSums("2024-01-01", "2024-01-31");
    expect(result).toEqual({ ask: 0, edit: 0, plan: 0, agent: 0, custom: 0, unknown: 0 });
  });

  it("sums chat mode columns", () => {
    insertMetric({ chat_panel_ask_mode: 5, chat_panel_agent_mode: 3 });
    insertMetric({ day: "2024-01-11", user_id: 1, chat_panel_ask_mode: 2, chat_panel_agent_mode: 1 });
    const result = getChatModeSums("2024-01-01", "2024-01-31");
    expect(result.ask).toBe(7);
    expect(result.agent).toBe(4);
  });

  it("filters by allowed logins", () => {
    insertMetric({ user_login: "user1", chat_panel_ask_mode: 5 });
    insertMetric({ user_login: "user2", user_id: 2, chat_panel_ask_mode: 10 });
    const result = getChatModeSums("2024-01-01", "2024-01-31", ["user1"]);
    expect(result.ask).toBe(5);
  });
});

describe("getAdoptionStats", () => {
  it("counts distinct users by feature", () => {
    insertMetric({ user_login: "user1", used_agent: 1, used_cli: 0 });
    insertMetric({ day: "2024-01-11", user_login: "user2", user_id: 2, used_agent: 0, used_cli: 1 });
    const stats = getAdoptionStats("2024-01-01", "2024-01-31");
    expect(stats.totalUsers).toBe(2);
    expect(stats.agentUsers).toBe(1);
    expect(stats.cliUsers).toBe(1);
  });
});

describe("getUserSummaries", () => {
  it("returns empty for no data", () => {
    expect(getUserSummaries("2024-01-01", "2024-01-31")).toEqual([]);
  });

  it("aggregates per user", () => {
    insertMetric({ day: "2024-01-10", user_login: "user1", loc_added_sum: 10 });
    insertMetric({ day: "2024-01-11", user_login: "user1", user_id: 1, loc_added_sum: 20 });
    const summaries = getUserSummaries("2024-01-01", "2024-01-31");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].locAdded).toBe(30);
    expect(summaries[0].activeDays).toBe(2);
    expect(summaries[0].usedAgent).toBe(true);
  });
});

describe("getAdoptionDailyTrend", () => {
  it("returns daily breakdown", () => {
    insertMetric({ day: "2024-01-10" });
    insertMetric({ day: "2024-01-11", user_id: 2, user_login: "user2" });
    const trend = getAdoptionDailyTrend("2024-01-01", "2024-01-31");
    expect(trend).toHaveLength(2);
    expect(trend[0].totalUsers).toBe(1);
  });
});

describe("getActiveUsersDailyTrend", () => {
  it("counts daily active users", () => {
    insertMetric({ day: "2024-01-10" });
    insertMetric({ day: "2024-01-10", user_id: 2, user_login: "user2", used_cli: 1 });
    const trend = getActiveUsersDailyTrend("2024-01-10", "2024-01-10");
    expect(trend).toHaveLength(1);
    expect(trend[0].daily).toBe(2);
    expect(trend[0].cliUsers).toBe(1);
  });
});

describe("getCompletionTotals", () => {
  it("returns zeros for empty data", () => {
    const totals = getCompletionTotals("2024-01-01", "2024-01-31");
    expect(totals.completionSuggested).toBe(0);
    expect(totals.completionAccepted).toBe(0);
  });

  it("sums completion metrics from json_each", () => {
    const features = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_feature)
      VALUES ('2024-01-10', 'ent1', 'ent1', 1, 'user1', ?)`).run(features);
    const totals = getCompletionTotals("2024-01-01", "2024-01-31");
    expect(totals.completionSuggested).toBe(100);
    expect(totals.completionAccepted).toBe(80);
    expect(totals.compGenCount).toBe(50);
    expect(totals.compAcceptCount).toBe(40);
  });
});

describe("getUserSummariesPaginated", () => {
  it("paginates user summaries", () => {
    insertMetric({ user_login: "alice", user_id: 1 });
    insertMetric({ user_login: "bob", user_id: 2 });
    insertMetric({ user_login: "charlie", user_id: 3 });
    const page1 = getUserSummariesPaginated("2024-01-01", "2024-01-31", 1, 2, "login", "asc");
    expect(page1.total).toBe(3);
    expect(page1.users).toHaveLength(2);
    expect(page1.users[0].login).toBe("alice");
  });

  it("supports search filter", () => {
    insertMetric({ user_login: "alice", user_id: 1 });
    insertMetric({ user_login: "bob", user_id: 2 });
    const result = getUserSummariesPaginated("2024-01-01", "2024-01-31", 1, 10, "login", "asc", "ali");
    expect(result.total).toBe(1);
    expect(result.users[0].login).toBe("alice");
  });
});

describe("getModelBreakdown", () => {
  it("aggregates model usage from json_each", () => {
    const modelFeature = JSON.stringify([
      { model: "gpt-4o", feature: "code_completion", user_initiated_interaction_count: 10 },
      { model: "claude-3.5", feature: "chat_panel", user_initiated_interaction_count: 5 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_model_feature)
      VALUES ('2024-01-10', 'ent1', 'ent1', 1, 'user1', ?)`).run(modelFeature);
    const breakdown = getModelBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown.length).toBeGreaterThanOrEqual(2);
    const gpt = breakdown.find((r) => r.model === "gpt-4o");
    expect(gpt!.interactions).toBe(10);
  });
});

describe("getFeatureBreakdown", () => {
  it("aggregates feature usage from json_each", () => {
    const features = JSON.stringify([
      { feature: "code_completion", user_initiated_interaction_count: 20, code_generation_activity_count: 10, code_acceptance_activity_count: 8, loc_added_sum: 50, loc_deleted_sum: 5 },
      { feature: "chat_panel", user_initiated_interaction_count: 15, code_generation_activity_count: 3, code_acceptance_activity_count: 0, loc_added_sum: 10, loc_deleted_sum: 0 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_feature)
      VALUES ('2024-01-10', 'ent1', 'ent1', 1, 'user1', ?)`).run(features);
    const breakdown = getFeatureBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown.length).toBeGreaterThanOrEqual(2);
    const comp = breakdown.find((r) => r.feature === "code_completion");
    expect(comp!.interactions).toBe(10); // code_generation_activity_count
    expect(comp!.locAdded).toBe(50);
  });
});
