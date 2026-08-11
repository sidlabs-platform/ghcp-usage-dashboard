import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  refreshUserSummary,
  refreshDailyAggregate,
  refreshDailyAggregateRange,
  refreshTeamSummary,
  refreshAllSummaries,
} from "./summary-tables";

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
  db.exec("DELETE FROM team_memberships");
  db.exec("DELETE FROM user_period_summary");
  db.exec("DELETE FROM daily_aggregate_cache");
  db.exec("DELETE FROM team_summary_cache");
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
    used_agent: 1,
    used_chat: 1,
    used_cli: 0,
    used_copilot_code_review_active: 0,
    used_copilot_code_review_passive: 0,
    used_copilot_coding_agent: 0,
    totals_by_feature: "[]",
  };
  const m = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_added_sum, loc_deleted_sum,
      used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive, used_copilot_coding_agent,
      totals_by_feature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.day, m.enterprise_id, m.enterprise_slug, m.user_id, m.user_login,
    m.code_generation_activity_count, m.code_acceptance_activity_count, m.user_initiated_interaction_count,
    m.loc_suggested_to_add_sum, m.loc_added_sum, m.loc_deleted_sum,
    m.used_agent, m.used_chat, m.used_cli, m.used_copilot_code_review_active, m.used_copilot_code_review_passive, m.used_copilot_coding_agent,
    m.totals_by_feature,
  );
}

describe("refreshUserSummary", () => {
  it("returns 0 for empty data", () => {
    expect(refreshUserSummary("2024-01-01", "2024-01-31")).toBe(0);
  });

  it("aggregates user metrics into summary", () => {
    insertMetric({ day: "2024-01-10" });
    insertMetric({ day: "2024-01-11", user_id: 1, loc_added_sum: 5 });
    const count = refreshUserSummary("2024-01-01", "2024-01-31");
    expect(count).toBe(1);
    const row = db.prepare("SELECT * FROM user_period_summary WHERE user_login = 'user1'").get() as any;
    expect(row.active_days).toBe(2);
    expect(row.loc_added).toBe(20); // 15 + 5
  });

  it("filters by enterprise slug", () => {
    insertMetric({ enterprise_slug: "ent1" });
    insertMetric({ enterprise_slug: "ent2", enterprise_id: "ent2", user_id: 2, user_login: "user2" });
    const count = refreshUserSummary("2024-01-01", "2024-01-31", "ent1");
    expect(count).toBe(1);
  });
});

describe("refreshDailyAggregate", () => {
  it("creates aggregate row for a day", () => {
    insertMetric({ day: "2024-01-10" });
    insertMetric({ day: "2024-01-10", user_id: 2, user_login: "user2", used_agent: 0 });
    refreshDailyAggregate("2024-01-10");
    const row = db.prepare("SELECT * FROM daily_aggregate_cache WHERE day = '2024-01-10'").get() as any;
    expect(row.total_users).toBe(2);
    expect(row.agent_users).toBe(1);
  });

  it("scopes to enterprise slug when provided", () => {
    insertMetric({ day: "2024-01-12", enterprise_slug: "ent-a", user_login: "u1" });
    insertMetric({ day: "2024-01-12", enterprise_slug: "ent-b", user_id: 2, user_login: "u2" });
    refreshDailyAggregate("2024-01-12", "ent-a");
    const rows = db.prepare("SELECT * FROM daily_aggregate_cache WHERE day = '2024-01-12'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].enterprise_slug).toBe("ent-a");
    expect(rows[0].total_users).toBe(1);
  });
});

describe("refreshDailyAggregateRange", () => {
  it("refreshes multiple days", () => {
    insertMetric({ day: "2024-01-10" });
    insertMetric({ day: "2024-01-11", user_id: 1 });
    const count = refreshDailyAggregateRange("2024-01-10", "2024-01-11");
    expect(count).toBe(2);
    const rows = db.prepare("SELECT * FROM daily_aggregate_cache ORDER BY day").all();
    expect(rows).toHaveLength(2);
  });

  it("scopes to enterprise slug when provided", () => {
    insertMetric({ day: "2024-01-13", enterprise_slug: "ea", user_login: "u1" });
    insertMetric({ day: "2024-01-13", enterprise_slug: "eb", user_id: 2, user_login: "u2" });
    const count = refreshDailyAggregateRange("2024-01-13", "2024-01-13", "ea");
    expect(count).toBe(1);
    const rows = db.prepare("SELECT * FROM daily_aggregate_cache WHERE day = '2024-01-13'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].enterprise_slug).toBe("ea");
  });
});

describe("refreshTeamSummary", () => {
  it("returns 0 with no teams", () => {
    expect(refreshTeamSummary("2024-01-01", "2024-01-31")).toBe(0);
  });

  it("computes team metrics from memberships + user data", () => {
    insertMetric({ day: "2024-01-10", user_login: "user1" });
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'team-a', 'Team A', 'org', 'org1', 'user1', '2024-01-01')
    `).run();
    const count = refreshTeamSummary("2024-01-01", "2024-01-31");
    expect(count).toBe(1);
    const row = db.prepare("SELECT * FROM team_summary_cache WHERE team_slug = 'team-a'").get() as any;
    expect(row.active_members).toBe(1);
    expect(row.total_loc_added).toBe(15);
  });

  it("refreshTeamSummary with enterpriseSlug filters by enterprise", () => {
    insertMetric({ day: "2024-01-10", user_login: "user1", enterprise_slug: "ent-x" });
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent-x', 'team-x', 'Team X', 'org', 'org1', 'user1', '2024-01-01')
    `).run();
    const count = refreshTeamSummary("2024-01-01", "2024-01-31", "ent-x");
    expect(count).toBe(1);
  });

  it("isolates metrics across enterprises (no cross-contamination)", () => {
    // Enterprise A: user1 has LOC=100
    insertMetric({ day: "2024-01-10", user_login: "user1", enterprise_slug: "ent-a", enterprise_id: "a", user_id: 1, loc_added_sum: 100 });
    db.prepare(`INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent-a', 'frontend', 'Frontend', 'org', 'org-a', 'user1', '2024-01-01')`).run();
    // Enterprise B: user1 has LOC=200 (same login, different enterprise)
    insertMetric({ day: "2024-01-10", user_login: "user1", enterprise_slug: "ent-b", enterprise_id: "b", user_id: 1, loc_added_sum: 200 });
    db.prepare(`INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent-b', 'frontend', 'Frontend', 'org', 'org-b', 'user1', '2024-01-01')`).run();

    refreshTeamSummary("2024-01-01", "2024-01-31");
    const rows = db.prepare("SELECT * FROM team_summary_cache WHERE team_slug = 'frontend' ORDER BY enterprise_slug").all() as any[];
    // Should produce 2 separate rows, one per enterprise — NOT merged
    expect(rows).toHaveLength(2);
    expect(rows[0].enterprise_slug).toBe("ent-a");
    expect(rows[0].total_loc_added).toBe(100);
    expect(rows[1].enterprise_slug).toBe("ent-b");
    expect(rows[1].total_loc_added).toBe(200);
  });
});

describe("refreshAllSummaries", () => {
  it("calls all refresh functions without error", () => {
    insertMetric({ day: "2024-01-10" });
    expect(() => refreshAllSummaries("2024-01-10", "2024-01-10")).not.toThrow();
  });
});

// ── Completion classification (IS_COMPLETION_SQL) ──────────────────────
//
// Proves refreshUserSummary/refreshDailyAggregate/refreshTeamSummary use the
// shared IS_COMPLETION_SQL allowlist rather than a bare `!= 'agent_edit'`
// exclusion: copilot_app, chat_inline, and unknown features must never enter
// completion acceptance/LoC, while code_completion, inline_chat, and
// chat_panel_* modes must.
describe("completion classification consistency", () => {
  function insertMetricWithFeatures(overrides: Partial<Record<string, unknown>> = {}) {
    const totalsByFeature = JSON.stringify([
      // Completion features — must count towards completion acceptance/LoC.
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, loc_deleted_sum: 0, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
      { feature: "inline_chat", loc_suggested_to_add_sum: 30, loc_added_sum: 25, loc_deleted_sum: 0, code_generation_activity_count: 6, code_acceptance_activity_count: 4 },
      { feature: "chat_panel_agent_mode", loc_suggested_to_add_sum: 0, loc_added_sum: 15, loc_deleted_sum: 0, code_generation_activity_count: 3, code_acceptance_activity_count: 2 },
      // Agent — must be excluded from completion, and separated into agent LOC.
      { feature: "agent_edit", loc_suggested_to_add_sum: 0, loc_added_sum: 500, loc_deleted_sum: 200, code_generation_activity_count: 10, code_acceptance_activity_count: 0 },
      // Copilot App and unrecognized features — huge values that would dominate
      // if leaked into completion; must be fully excluded.
      { feature: "copilot_app", loc_suggested_to_add_sum: 9000, loc_added_sum: 9000, loc_deleted_sum: 0, code_generation_activity_count: 9000, code_acceptance_activity_count: 9000 },
      { feature: "chat_inline", loc_suggested_to_add_sum: 9000, loc_added_sum: 9000, loc_deleted_sum: 0, code_generation_activity_count: 9000, code_acceptance_activity_count: 9000 },
      { feature: "some_future_unknown_feature", loc_suggested_to_add_sum: 9000, loc_added_sum: 9000, loc_deleted_sum: 0, code_generation_activity_count: 9000, code_acceptance_activity_count: 9000 },
    ]);
    insertMetric({
      totals_by_feature: totalsByFeature,
      // Top-level columns mirror the sum of every feature row above (as the
      // real sync would produce), so the completion-only override must
      // actually differ from the unfiltered top-level rate/LoC.
      code_generation_activity_count: 50 + 6 + 3 + 10 + 9000 + 9000 + 9000,
      code_acceptance_activity_count: 40 + 4 + 2 + 0 + 9000 + 9000 + 9000,
      loc_suggested_to_add_sum: 100 + 30 + 0 + 0 + 9000 + 9000 + 9000,
      loc_added_sum: 80 + 25 + 15 + 500 + 9000 + 9000 + 9000,
      loc_deleted_sum: 0 + 0 + 0 + 200 + 0 + 0 + 0,
      ...overrides,
    });
  }

  it("refreshUserSummary computes completion-only acceptance_rate", () => {
    insertMetricWithFeatures({ day: "2024-02-01", user_login: "octocat" });
    refreshUserSummary("2024-02-01", "2024-02-01");
    const row = db.prepare("SELECT * FROM user_period_summary WHERE user_login = 'octocat'").get() as any;
    // compGenCount = 50 + 6 + 3 = 59; compAcceptCount = 40 + 4 + 2 = 46
    // rate = 46/59*100 = 77.9661... -> rounded to 1 decimal = 78 (matches DB ROUND(..., 1))
    expect(row.acceptance_rate).toBe(78);
  });

  it("refreshDailyAggregate computes completion-only LOC and separates agent LOC", () => {
    insertMetricWithFeatures({ day: "2024-02-02", user_login: "octocat" });
    refreshDailyAggregate("2024-02-02");
    const row = db.prepare("SELECT * FROM daily_aggregate_cache WHERE day = '2024-02-02'").get() as any;
    expect(row.completion_loc_suggested).toBe(130); // 100 + 30 + 0
    expect(row.completion_loc_accepted).toBe(120); // 80 + 25 + 15
    expect(row.agent_loc_added).toBe(500);
  });

  it("refreshTeamSummary computes completion-only overall_acceptance_rate", () => {
    insertMetricWithFeatures({ day: "2024-02-03", user_login: "octocat" });
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'team-completion', 'Team Completion', 'org', 'org1', 'octocat', '2024-01-01')
    `).run();
    refreshTeamSummary("2024-02-03", "2024-02-03");
    const row = db.prepare("SELECT * FROM team_summary_cache WHERE team_slug = 'team-completion'").get() as any;
    expect(row.overall_acceptance_rate).toBe(78);
  });
});
