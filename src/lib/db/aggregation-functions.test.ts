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
  getLanguageBreakdown,
  getLanguageByFeatureBreakdown,
  getFeatureDailyTrend,
  getCompletionDailyTrend,
  getIdeBreakdown,
  getIdeTrend,
  getFeatureUsageDaily,
  getModelByFeatureBreakdown,
  getModelTrend,
  getCliDailyVolume,
  getCliUserBreakdown,
  estimateRowCount,
  getActiveUsersRollingTrend,
  getModelByLanguageBreakdown,
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
    ai_credits_used: 0,
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
      ai_credits_used, loc_suggested_to_add_sum, loc_added_sum, loc_deleted_sum,
      chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_edit_mode, chat_panel_plan_mode,
      chat_panel_custom_mode, chat_panel_unknown_mode,
      used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive, used_copilot_coding_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.day, m.enterprise_id, m.enterprise_slug, m.user_id, m.user_login,
    m.code_generation_activity_count, m.code_acceptance_activity_count, m.user_initiated_interaction_count,
    m.ai_credits_used, m.loc_suggested_to_add_sum, m.loc_added_sum, m.loc_deleted_sum,
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

  it("filters by enterprise slugs", () => {
    insertMetric({ enterprise_slug: "ent-a", chat_panel_ask_mode: 4 });
    insertMetric({ enterprise_slug: "ent-b", user_id: 2, chat_panel_ask_mode: 6 });
    const result = getChatModeSums("2024-01-01", "2024-01-31", undefined, ["ent-a"]);
    expect(result.ask).toBe(4);
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

  it("aggregates AI credits used per user", () => {
    insertMetric({ day: "2024-01-10", user_login: "credit-user", ai_credits_used: 1.5 });
    insertMetric({ day: "2024-01-11", user_login: "credit-user", ai_credits_used: 2.25 });

    const summaries = getUserSummaries("2024-01-01", "2024-01-31");
    const creditUser = summaries.find((s) => s.login === "credit-user");
    expect(creditUser).toBeDefined();
    expect(creditUser!.aiCreditsUsed).toBeCloseTo(3.75, 6);
  });

  it("returns acceptanceRate 0 when codeGen is 0", () => {
    insertMetric({ user_login: "zero-gen", user_id: 99, code_generation_activity_count: 0, code_acceptance_activity_count: 0 });
    const summaries = getUserSummaries("2024-01-01", "2024-01-31");
    const u = summaries.find((s) => s.login === "zero-gen");
    expect(u!.acceptanceRate).toBe(0);
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

  it("falls back to activeDays sort for unknown sort field", () => {
    insertMetric({ user_login: "alice", user_id: 1 });
    insertMetric({ user_login: "bob", user_id: 2 });
    const result = getUserSummariesPaginated("2024-01-01", "2024-01-31", 1, 10, "unknownField", "desc");
    expect(result.total).toBe(2);
  });

  it("includeInactive adds seat-only users with zero metrics", () => {
    // Active user with metrics
    insertMetric({ user_login: "active-user", user_id: 10 });
    // Seat-only user (no metrics in the date range)
    db.prepare(`INSERT INTO copilot_seats (enterprise_slug, org_slug, user_login, user_id)
      VALUES ('ent1', 'org1', 'inactive-user', 20)`).run();
    try {
      const result = getUserSummariesPaginated(
        "2024-01-01", "2024-01-31", 1, 50, "login", "asc",
        undefined, undefined, undefined, true,
      );
      expect(result.total).toBe(2);
      const active = result.users.find((u) => u.login === "active-user");
      const inactive = result.users.find((u) => u.login === "inactive-user");
      expect(active!.activeDays).toBeGreaterThan(0);
      expect(inactive!.activeDays).toBe(0);
      expect(inactive!.locAdded).toBe(0);
    } finally {
      db.prepare("DELETE FROM copilot_seats").run();
    }
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
    expect(comp!.interactions).toBe(20); // user_initiated_interaction_count
    expect(comp!.locAdded).toBe(50);
  });
});

describe("getLanguageBreakdown", () => {
  it("aggregates language LOC from json_each", () => {
    const langFeature = JSON.stringify([
      { language: "TypeScript", loc_added_sum: 100, loc_suggested_to_add_sum: 120, code_generation_activity_count: 10, code_acceptance_activity_count: 8 },
      { language: "Python", loc_added_sum: 50, loc_suggested_to_add_sum: 60, code_generation_activity_count: 5, code_acceptance_activity_count: 3 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_language_feature)
      VALUES ('2024-01-12', 'ent1', 'ent1', 1, 'user1', ?)`).run(langFeature);
    const breakdown = getLanguageBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown.length).toBeGreaterThanOrEqual(2);
    const ts = breakdown.find((r) => r.language === "TypeScript");
    expect(ts!.locAdded).toBe(100);
  });
});

describe("getLanguageByFeatureBreakdown", () => {
  it("includes generations and acceptances per language", () => {
    const langFeature = JSON.stringify([
      { language: "Go", loc_added_sum: 30, loc_deleted_sum: 5, code_generation_activity_count: 7, code_acceptance_activity_count: 4 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_language_feature)
      VALUES ('2024-01-13', 'ent1', 'ent1', 1, 'user1', ?)`).run(langFeature);
    const breakdown = getLanguageByFeatureBreakdown("2024-01-01", "2024-01-31");
    const go = breakdown.find((r) => r.language === "Go");
    expect(go!.generations).toBe(7);
    expect(go!.acceptances).toBe(4);
  });
});

describe("getFeatureDailyTrend", () => {
  it("returns daily interactions per feature", () => {
    const features = JSON.stringify([
      { feature: "code_completion", user_initiated_interaction_count: 20, code_generation_activity_count: 10, code_acceptance_activity_count: 8, loc_added_sum: 50, loc_deleted_sum: 5 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_feature)
      VALUES ('2024-01-14', 'ent1', 'ent1', 1, 'user1', ?)`).run(features);
    const trend = getFeatureDailyTrend("2024-01-01", "2024-01-31");
    const row = trend.find((r) => r.day === "2024-01-14");
    expect(row!.feature).toBe("code_completion");
    expect(row!.interactions).toBe(20);
  });
});

describe("getCompletionDailyTrend", () => {
  it("returns daily completion vs agent metrics", () => {
    const features = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, loc_deleted_sum: 0, code_generation_activity_count: 20, code_acceptance_activity_count: 15 },
      { feature: "agent_edit", loc_suggested_to_add_sum: 0, loc_added_sum: 30, loc_deleted_sum: 10, code_generation_activity_count: 5, code_acceptance_activity_count: 5 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_feature)
      VALUES ('2024-01-15', 'ent1', 'ent1', 1, 'user1', ?)`).run(features);
    const trend = getCompletionDailyTrend("2024-01-01", "2024-01-31");
    const row = trend.find((r) => r.day === "2024-01-15");
    expect(row!.completionSuggested).toBe(100);
    expect(row!.completionAccepted).toBe(80);
    expect(row!.agentAdded).toBe(30);
    expect(row!.agentDeleted).toBe(10);
  });
});

describe("getIdeBreakdown", () => {
  it("aggregates IDE usage from json_each", () => {
    const ideData = JSON.stringify([
      { ide: "vscode", user_initiated_interaction_count: 50, code_generation_activity_count: 30, code_acceptance_activity_count: 20, loc_added_sum: 200, loc_deleted_sum: 10 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_ide)
      VALUES ('2024-01-16', 'ent1', 'ent1', 1, 'user1', ?)`).run(ideData);
    const breakdown = getIdeBreakdown("2024-01-01", "2024-01-31");
    const vs = breakdown.find((r) => r.ide === "vscode");
    expect(vs!.interactions).toBe(50);
    expect(vs!.locAdded).toBe(200);
  });
});

describe("getIdeTrend", () => {
  it("returns daily IDE interactions", () => {
    const ideData = JSON.stringify([
      { ide: "jetbrains", user_initiated_interaction_count: 25, code_generation_activity_count: 10, code_acceptance_activity_count: 5, loc_added_sum: 80, loc_deleted_sum: 3 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_ide)
      VALUES ('2024-01-17', 'ent1', 'ent1', 1, 'user1', ?)`).run(ideData);
    const trend = getIdeTrend("2024-01-01", "2024-01-31");
    const row = trend.find((r) => r.day === "2024-01-17" && r.ide === "jetbrains");
    expect(row!.interactions).toBe(25);
  });
});

describe("getFeatureUsageDaily", () => {
  it("returns daily feature usage from structured columns", () => {
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, code_generation_activity_count, used_chat, used_agent, used_cli)
      VALUES ('2024-01-18', 'ent1', 'ent1', 1, 'user1', 15, 1, 1, 0)`).run();
    const daily = getFeatureUsageDaily("2024-01-01", "2024-01-31");
    const row = daily.find((r) => r.day === "2024-01-18");
    expect(row!.completions).toBeGreaterThanOrEqual(15);
    expect(row!.chatUsers).toBeGreaterThanOrEqual(1);
  });
});

describe("getModelByFeatureBreakdown", () => {
  it("aggregates model×feature from json_each", () => {
    const modelFeature = JSON.stringify([
      { model: "gpt-4o", feature: "code_completion", user_initiated_interaction_count: 30 },
      { model: "gpt-4o", feature: "chat_panel", user_initiated_interaction_count: 10 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_model_feature)
      VALUES ('2024-01-19', 'ent1', 'ent1', 1, 'user1', ?)`).run(modelFeature);
    const breakdown = getModelByFeatureBreakdown("2024-01-01", "2024-01-31");
    const comp = breakdown.find((r) => r.model === "gpt-4o" && r.feature === "code_completion");
    expect(comp!.interactions).toBe(30);
  });
});

describe("getModelTrend", () => {
  it("returns daily interactions for specified models", () => {
    const modelFeature = JSON.stringify([
      { model: "claude-3.5", feature: "chat_panel", user_initiated_interaction_count: 15 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_model_feature)
      VALUES ('2024-01-20', 'ent1', 'ent1', 1, 'user1', ?)`).run(modelFeature);
    const trend = getModelTrend("2024-01-01", "2024-01-31", ["claude-3.5"]);
    const row = trend.find((r) => r.day === "2024-01-20");
    expect(row!.interactions).toBe(15);
  });

  it("returns empty for empty topModels", () => {
    expect(getModelTrend("2024-01-01", "2024-01-31", [])).toEqual([]);
  });
});

describe("getCliDailyVolume", () => {
  function insertCliMetric(overrides: Partial<Record<string, unknown>> = {}) {
    const defaults = {
      day: "2024-01-21",
      enterprise_id: "ent1",
      enterprise_slug: "ent1",
      user_id: 1,
      user_login: "cli-user",
      used_cli: 1,
      totals_by_cli: JSON.stringify({
        session_count: 5,
        request_count: 10,
        prompt_count: 8,
        token_usage: {
          prompt_tokens_sum: 1000,
          output_tokens_sum: 500,
        },
      }),
    };
    const metric = { ...defaults, ...overrides };
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, used_cli, totals_by_cli)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      metric.day,
      metric.enterprise_id,
      metric.enterprise_slug,
      metric.user_id,
      metric.user_login,
      metric.used_cli,
      metric.totals_by_cli,
    );
  }

  it("returns empty array when no CLI users exist", () => {
    insertMetric({ used_cli: 0, user_login: "ide-user", user_id: 7 });

    expect(getCliDailyVolume("2024-01-01", "2024-01-31")).toEqual([]);
  });

  it("aggregates sessions requests and tokens by day", () => {
    insertCliMetric();
    insertCliMetric({
      day: "2024-01-21",
      enterprise_id: "ent1",
      enterprise_slug: "ent1",
      user_id: 2,
      user_login: "cli-user-2",
      totals_by_cli: JSON.stringify({
        session_count: 2,
        request_count: 5,
        prompt_count: 3,
        token_usage: {
          prompt_tokens_sum: 200,
          output_tokens_sum: 100,
        },
      }),
    });
    insertCliMetric({
      day: "2024-01-22",
      enterprise_id: "ent1",
      enterprise_slug: "ent1",
      user_id: 1,
      user_login: "cli-user",
      totals_by_cli: JSON.stringify({
        session_count: 1,
        request_count: 4,
        prompt_count: 2,
        token_usage: {
          prompt_tokens_sum: 50,
          output_tokens_sum: 25,
        },
      }),
    });

    expect(getCliDailyVolume("2024-01-01", "2024-01-31")).toEqual([
      {
        day: "2024-01-21",
        sessions: 7,
        requests: 15,
        prompts: 11,
        promptTokens: 1200,
        outputTokens: 600,
      },
      {
        day: "2024-01-22",
        sessions: 1,
        requests: 4,
        prompts: 2,
        promptTokens: 50,
        outputTokens: 25,
      },
    ]);
  });

  it("sums volume across enterprises for the same day", () => {
    insertCliMetric({
      day: "2024-01-23",
      enterprise_id: "ent1",
      enterprise_slug: "ent-alpha",
      user_id: 1,
      user_login: "alpha-user",
      totals_by_cli: JSON.stringify({
        session_count: 3,
        request_count: 6,
        prompt_count: 4,
        token_usage: {
          prompt_tokens_sum: 300,
          output_tokens_sum: 120,
        },
      }),
    });
    insertCliMetric({
      day: "2024-01-23",
      enterprise_id: "ent2",
      enterprise_slug: "ent-beta",
      user_id: 2,
      user_login: "beta-user",
      totals_by_cli: JSON.stringify({
        session_count: 4,
        request_count: 8,
        prompt_count: 5,
        token_usage: {
          prompt_tokens_sum: 500,
          output_tokens_sum: 200,
        },
      }),
    });

    expect(getCliDailyVolume("2024-01-01", "2024-01-31")).toEqual([
      {
        day: "2024-01-23",
        sessions: 7,
        requests: 14,
        prompts: 9,
        promptTokens: 800,
        outputTokens: 320,
      },
    ]);
  });

  it("respects enterprise slug filter", () => {
    insertCliMetric({
      day: "2024-01-24",
      enterprise_id: "ent1",
      enterprise_slug: "ent-alpha",
      user_id: 1,
      user_login: "alpha-user",
      totals_by_cli: JSON.stringify({
        session_count: 2,
        request_count: 4,
        prompt_count: 3,
        token_usage: {
          prompt_tokens_sum: 200,
          output_tokens_sum: 80,
        },
      }),
    });
    insertCliMetric({
      day: "2024-01-24",
      enterprise_id: "ent2",
      enterprise_slug: "ent-beta",
      user_id: 2,
      user_login: "beta-user",
      totals_by_cli: JSON.stringify({
        session_count: 7,
        request_count: 14,
        prompt_count: 10,
        token_usage: {
          prompt_tokens_sum: 700,
          output_tokens_sum: 280,
        },
      }),
    });

    expect(getCliDailyVolume("2024-01-01", "2024-01-31", undefined, ["ent-alpha"])).toEqual([
      {
        day: "2024-01-24",
        sessions: 2,
        requests: 4,
        prompts: 3,
        promptTokens: 200,
        outputTokens: 80,
      },
    ]);
  });

  it("respects login filter", () => {
    insertCliMetric({
      day: "2024-01-25",
      enterprise_id: "ent1",
      enterprise_slug: "ent1",
      user_id: 1,
      user_login: "included-user",
      totals_by_cli: JSON.stringify({
        session_count: 6,
        request_count: 12,
        prompt_count: 9,
        token_usage: {
          prompt_tokens_sum: 600,
          output_tokens_sum: 240,
        },
      }),
    });
    insertCliMetric({
      day: "2024-01-25",
      enterprise_id: "ent1",
      enterprise_slug: "ent1",
      user_id: 2,
      user_login: "excluded-user",
      totals_by_cli: JSON.stringify({
        session_count: 1,
        request_count: 3,
        prompt_count: 2,
        token_usage: {
          prompt_tokens_sum: 90,
          output_tokens_sum: 30,
        },
      }),
    });

    expect(getCliDailyVolume("2024-01-01", "2024-01-31", ["included-user"])).toEqual([
      {
        day: "2024-01-25",
        sessions: 6,
        requests: 12,
        prompts: 9,
        promptTokens: 600,
        outputTokens: 240,
      },
    ]);
  });
});

describe("getCliUserBreakdown", () => {
  it("aggregates CLI usage per user", () => {
    const cliData = JSON.stringify({ session_count: 5, request_count: 10, prompt_count: 8, token_usage: { prompt_tokens_sum: 1000, output_tokens_sum: 500 } });
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, used_cli, totals_by_cli)
      VALUES ('2024-01-21', 'ent1', 'ent1', 1, 'cli-user', 1, ?)`).run(cliData);
    const breakdown = getCliUserBreakdown("2024-01-01", "2024-01-31");
    const user = breakdown.find((r) => r.login === "cli-user");
    expect(user!.sessions).toBe(5);
    expect(user!.requests).toBe(10);
  });
});

describe("estimateRowCount", () => {
  it("returns count and exceeds flag", () => {
    const result = estimateRowCount("2024-01-01", "2024-01-31");
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(typeof result.exceeds).toBe("boolean");
  });
});

describe("getActiveUsersRollingTrend", () => {
  it("returns daily/weekly/monthly rolling user counts", () => {
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, used_cli)
      VALUES ('2024-01-22', 'ent1', 'ent1', 1, 'rolling-user', 0)`).run();
    const trend = getActiveUsersRollingTrend("2024-01-22", "2024-01-22");
    expect(trend.length).toBeGreaterThanOrEqual(1);
    expect(trend[0].daily).toBeGreaterThanOrEqual(1);
    expect(typeof trend[0].weekly).toBe("number");
    expect(typeof trend[0].monthly).toBe("number");
  });
});

describe("getModelByLanguageBreakdown", () => {
  it("aggregates model×language from json_each", () => {
    const langModel = JSON.stringify([
      { model: "gpt-4o", language: "Python", user_initiated_interaction_count: 40 },
    ]);
    db.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_language_model)
      VALUES ('2024-01-23', 'ent1', 'ent1', 1, 'user1', ?)`).run(langModel);
    const breakdown = getModelByLanguageBreakdown("2024-01-01", "2024-01-31");
    const py = breakdown.find((r) => r.model === "gpt-4o" && r.language === "Python");
    expect(py!.interactions).toBe(40);
  });
});
