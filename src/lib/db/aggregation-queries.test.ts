import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";
// Import the real, single-source-of-truth SQL predicate constants instead of
// re-declaring local copies — this way these tests exercise (and would break
// on any regression to) the exact fragment every production query uses.
import { IS_COMPLETION_SQL, IS_AGENT_SQL, IS_COPILOT_APP_SQL, NOT_AGENT_OR_APP_SQL } from "./aggregation-queries";

// We test the SQL queries directly against a temporary in-memory DB
// to verify json_each aggregation logic

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  // Load schemas
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  const summarySchemaPath = path.join(process.cwd(), "src", "lib", "db", "summary-schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
  db.exec(fs.readFileSync(summarySchemaPath, "utf-8"));

  // Insert test data
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

  const modelFeature1 = JSON.stringify([
    { model: "gpt-4o", feature: "code_completion", user_initiated_interaction_count: 10 },
    { model: "gpt-4o", feature: "chat_panel", user_initiated_interaction_count: 5 },
    { model: "claude-3.5", feature: "agent_edit", user_initiated_interaction_count: 3 },
  ]);
  const modelFeature2 = JSON.stringify([
    { model: "gpt-4o", feature: "code_completion", user_initiated_interaction_count: 20 },
    { model: "claude-3.5", feature: "chat_panel", user_initiated_interaction_count: 7 },
  ]);

  const langFeature1 = JSON.stringify([
    { language: "typescript", feature: "code_completion", loc_added_sum: 100, loc_suggested_to_add_sum: 200, loc_deleted_sum: 10, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
    { language: "python", feature: "code_completion", loc_added_sum: 50, loc_suggested_to_add_sum: 100, loc_deleted_sum: 5, code_generation_activity_count: 25, code_acceptance_activity_count: 20 },
  ]);

  const langModel1 = JSON.stringify([
    { model: "gpt-4o", language: "typescript", user_initiated_interaction_count: 15 },
    { model: "gpt-4o", language: "python", user_initiated_interaction_count: 8 },
  ]);

  const ide1 = JSON.stringify([
    { ide: "vscode", loc_added_sum: 100, loc_deleted_sum: 10, user_initiated_interaction_count: 50, code_generation_activity_count: 30, code_acceptance_activity_count: 25 },
    { ide: "jetbrains", loc_added_sum: 30, loc_deleted_sum: 5, user_initiated_interaction_count: 15, code_generation_activity_count: 10, code_acceptance_activity_count: 8 },
  ]);

  const feature1 = JSON.stringify([
    { feature: "code_completion", loc_added_sum: 80, loc_suggested_to_add_sum: 150, loc_deleted_sum: 5, code_generation_activity_count: 40, code_acceptance_activity_count: 30, user_initiated_interaction_count: 40 },
    { feature: "agent_edit", loc_added_sum: 20, loc_suggested_to_add_sum: 0, loc_deleted_sum: 10, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 5 },
    { feature: "chat_panel", loc_added_sum: 10, loc_suggested_to_add_sum: 20, loc_deleted_sum: 0, code_generation_activity_count: 5, code_acceptance_activity_count: 3, user_initiated_interaction_count: 15 },
  ]);

  const cli1 = JSON.stringify({ session_count: 5, request_count: 20, prompt_count: 15, token_usage: { prompt_tokens_sum: 1000, output_tokens_sum: 500, avg_tokens_per_request: 75 } });

  // User 1, Day 1
  insert.run("2025-04-01", "ent1", "test-enterprise", 1, "alice",
    40, 30, 60, 150, 5, 110, 15, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0,
    ide1, feature1, langFeature1,
    modelFeature1, langModel1, cli1);

  // User 2, Day 1
  insert.run("2025-04-01", "ent1", "test-enterprise", 2, "bob",
    20, 15, 27, 100, 0, 50, 5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
    "[]", feature1, "[]",
    modelFeature2, "[]", null);

  // User 1, Day 2
  insert.run("2025-04-02", "ent1", "test-enterprise", 1, "alice",
    30, 25, 45, 120, 3, 90, 12, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0,
    ide1, feature1, langFeature1,
    modelFeature1, langModel1, null);
});

afterAll(() => {
  db.close();
});

describe("SQL json_each aggregation queries", () => {
  it("aggregates model breakdown correctly", () => {
    const rows = db.prepare(`
      SELECT
        json_extract(j.value, '$.model') as model,
        COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
      FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
      WHERE u.day >= '2025-04-01' AND u.day <= '2025-04-02'
        AND u.totals_by_model_feature IS NOT NULL AND u.totals_by_model_feature != '[]'
      GROUP BY model
      ORDER BY interactions DESC
    `).all() as { model: string; interactions: number }[];

    expect(rows.length).toBe(2);
    // gpt-4o: (10+5) + 20 + (10+5) = 50
    const gpt = rows.find((r) => r.model === "gpt-4o");
    expect(gpt).toBeDefined();
    expect(gpt!.interactions).toBe(50);
    // claude-3.5: 3 + 7 + 3 = 13
    const claude = rows.find((r) => r.model === "claude-3.5");
    expect(claude).toBeDefined();
    expect(claude!.interactions).toBe(13);
  });

  it("aggregates model x feature breakdown correctly", () => {
    const rows = db.prepare(`
      SELECT
        json_extract(j.value, '$.model') as model,
        json_extract(j.value, '$.feature') as feature,
        COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
      FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
      WHERE u.day >= '2025-04-01' AND u.day <= '2025-04-02'
        AND u.totals_by_model_feature IS NOT NULL AND u.totals_by_model_feature != '[]'
      GROUP BY model, feature
      ORDER BY interactions DESC
    `).all() as { model: string; feature: string; interactions: number }[];

    const gptCompletion = rows.find((r) => r.model === "gpt-4o" && r.feature === "code_completion");
    expect(gptCompletion).toBeDefined();
    // gpt-4o + code_completion: 10 + 20 + 10 = 40
    expect(gptCompletion!.interactions).toBe(40);
  });

  it("aggregates completion vs agent daily trend", () => {
    const rows = db.prepare(`
      SELECT
        u.day,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
          THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as completionSuggested,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
          THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
        COALESCE(SUM(CASE WHEN ${IS_AGENT_SQL}
          THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as agentAdded
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day >= '2025-04-01' AND u.day <= '2025-04-02'
        AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
      GROUP BY u.day
      ORDER BY u.day ASC
    `).all() as { day: string; completionSuggested: number; completionAccepted: number; agentAdded: number }[];

    expect(rows.length).toBe(2);
    // Day 1: 2 users × (150 + 20) completion suggested = 340
    expect(rows[0].completionSuggested).toBe(340);
    // Day 1: 2 users × (80 + 10) completion accepted = 180
    expect(rows[0].completionAccepted).toBe(180);
    // Day 1: 2 users × 20 agent added = 40
    expect(rows[0].agentAdded).toBe(40);
  });

  it("aggregates IDE breakdown correctly", () => {
    const rows = db.prepare(`
      SELECT
        json_extract(j.value, '$.ide') as ide,
        COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
      FROM user_daily_metrics u, json_each(u.totals_by_ide) j
      WHERE u.day >= '2025-04-01' AND u.day <= '2025-04-02'
        AND u.totals_by_ide IS NOT NULL AND u.totals_by_ide != '[]'
      GROUP BY ide
      ORDER BY interactions DESC
    `).all() as { ide: string; interactions: number }[];

    expect(rows.length).toBe(2);
    const vscode = rows.find((r) => r.ide === "vscode");
    expect(vscode).toBeDefined();
    // alice day1 + alice day2: 50 + 50 = 100
    expect(vscode!.interactions).toBe(100);
  });

  it("aggregates CLI user breakdown correctly", () => {
    const rows = db.prepare(`
      SELECT
        user_login as login,
        COALESCE(SUM(json_extract(totals_by_cli, '$.session_count')), 0) as sessions,
        COALESCE(SUM(json_extract(totals_by_cli, '$.request_count')), 0) as requests,
        COUNT(*) as days
      FROM user_daily_metrics
      WHERE day >= '2025-04-01' AND day <= '2025-04-02'
        AND used_cli = 1
        AND totals_by_cli IS NOT NULL
      GROUP BY user_login
      ORDER BY sessions DESC
    `).all() as { login: string; sessions: number; requests: number; days: number }[];

    expect(rows.length).toBe(1); // only alice has CLI data
    expect(rows[0].login).toBe("alice");
    expect(rows[0].sessions).toBe(5);
    expect(rows[0].requests).toBe(20);
    expect(rows[0].days).toBe(1);
  });

  it("filters by user login correctly", () => {
    const rows = db.prepare(`
      SELECT
        json_extract(j.value, '$.model') as model,
        COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
      FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
      WHERE u.day >= '2025-04-01' AND u.day <= '2025-04-02'
        AND u.totals_by_model_feature IS NOT NULL AND u.totals_by_model_feature != '[]'
        AND u.user_login IN ('alice')
      GROUP BY model
      ORDER BY interactions DESC
    `).all() as { model: string; interactions: number }[];

    // Only alice's data: gpt-4o (10+5) * 2 days = 30, claude-3.5 3 * 2 = 6
    const gpt = rows.find((r) => r.model === "gpt-4o");
    expect(gpt!.interactions).toBe(30);
    const claude = rows.find((r) => r.model === "claude-3.5");
    expect(claude!.interactions).toBe(6);
  });

  it("row count estimation works", () => {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM user_daily_metrics
      WHERE day >= '2025-04-01' AND day <= '2025-04-02'
    `).get() as { cnt: number };

    expect(row.cnt).toBe(3); // 2 users day1 + 1 user day2
  });

  it("rolling window for 7-day WAU calculates correctly", () => {
    // Test data:
    // 2025-04-01: alice, bob (2 users)
    // 2025-04-02: alice (1 user)
    const rows = db.prepare(`
      SELECT
        m.day,
        COUNT(DISTINCT m.user_login) as daily,
        (SELECT COUNT(DISTINCT w.user_login)
         FROM user_daily_metrics w
         WHERE w.day BETWEEN date(m.day, '-6 days') AND m.day
        ) as weekly
      FROM user_daily_metrics m
      WHERE m.day >= '2025-04-01' AND m.day <= '2025-04-02'
      GROUP BY m.day
      ORDER BY m.day ASC
    `).all() as { day: string; daily: number; weekly: number }[];

    expect(rows.length).toBe(2);
    // 2025-04-01: 2 users (alice, bob) daily, same 2 in 7-day window
    expect(rows[0].day).toBe("2025-04-01");
    expect(rows[0].daily).toBe(2);
    expect(rows[0].weekly).toBe(2);

    // 2025-04-02: 1 user (alice) daily, 2 total in 7-day window (alice + bob)
    expect(rows[1].day).toBe("2025-04-02");
    expect(rows[1].daily).toBe(1);
    expect(rows[1].weekly).toBe(2); // alice (day1+day2 deduplicated) + bob (day1)
  });

  it("rolling window for 30-day MAU calculates correctly", () => {
    const rows = db.prepare(`
      SELECT
        m.day,
        COUNT(DISTINCT m.user_login) as daily,
        (SELECT COUNT(DISTINCT mo.user_login)
         FROM user_daily_metrics mo
         WHERE mo.day BETWEEN date(m.day, '-29 days') AND m.day
        ) as monthly
      FROM user_daily_metrics m
      WHERE m.day >= '2025-04-01' AND m.day <= '2025-04-02'
      GROUP BY m.day
      ORDER BY m.day ASC
    `).all() as { day: string; daily: number; monthly: number }[];

    expect(rows.length).toBe(2);
    // Over 30-day window, same results as 7-day since data is only 2 days
    expect(rows[0].monthly).toBe(2);
    expect(rows[1].monthly).toBe(2); // alice + bob deduplicated across 2 days
  });

  it("rolling window with filter by user login", () => {
    // Filter to only alice
    const rows = db.prepare(`
      SELECT
        m.day,
        COUNT(DISTINCT m.user_login) as daily,
        (SELECT COUNT(DISTINCT w.user_login)
         FROM user_daily_metrics w
         WHERE w.day BETWEEN date(m.day, '-6 days') AND m.day
           AND w.user_login IN ('alice')
        ) as weekly
      FROM user_daily_metrics m
      WHERE m.day >= '2025-04-01' AND m.day <= '2025-04-02'
        AND m.user_login IN ('alice')
      GROUP BY m.day
      ORDER BY m.day ASC
    `).all() as { day: string; daily: number; weekly: number }[];

    expect(rows.length).toBe(2);
    // alice appears on both days
    expect(rows[0].daily).toBe(1);
    expect(rows[0].weekly).toBe(1);
    expect(rows[1].daily).toBe(1);
    expect(rows[1].weekly).toBe(1); // alice deduplicated across window
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Multi-enterprise SQL deduplication tests
// Validates that all aggregation SQL patterns correctly handle users
// appearing across multiple enterprises.
// ═══════════════════════════════════════════════════════════════════════

describe("multi-enterprise SQL deduplication", () => {
  beforeAll(() => {
    // Insert multi-enterprise data with an overlapping user (alice in both)
    const insert = db.prepare(`
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const feature = JSON.stringify([
      { feature: "code_completion", loc_added_sum: 50, loc_suggested_to_add_sum: 100, loc_deleted_sum: 0,
        code_generation_activity_count: 20, code_acceptance_activity_count: 15, user_initiated_interaction_count: 20 },
      { feature: "agent_edit", loc_added_sum: 30, loc_suggested_to_add_sum: 0, loc_deleted_sum: 5,
        code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 3 },
    ]);

    // Ent-X, 2025-05-10: alice (agent=1, chat=1, cli=1)
    insert.run("2025-05-10", "ent-x", "mega-corp", 100, "alice",
      20, 15, 30, 100, 0, 80, 5, 0, 5, 0, 3, 0, 0, 1, 1, 1, 0, 0, 0,
      "[]", feature, "[]", "[]", "[]", null);

    // Ent-X, 2025-05-10: dave (agent=0, chat=1, cli=0)
    insert.run("2025-05-10", "ent-x", "mega-corp", 200, "dave",
      10, 8, 15, 50, 0, 40, 2, 0, 3, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
      "[]", feature, "[]", "[]", "[]", null);

    // Ent-Y, 2025-05-10: alice (same user, different enterprise)
    insert.run("2025-05-10", "ent-y", "init-tech", 100, "alice",
      18, 12, 25, 90, 0, 70, 4, 0, 4, 0, 2, 0, 0, 1, 1, 1, 0, 0, 0,
      "[]", feature, "[]", "[]", "[]", null);

    // Ent-Y, 2025-05-10: eve (agent=1, chat=0, cli=1)
    insert.run("2025-05-10", "ent-y", "init-tech", 300, "eve",
      8, 5, 12, 40, 0, 30, 2, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0,
      "[]", feature, "[]", "[]", "[]", null);

    // Day 2: only alice in ent-x + new user frank in ent-y
    insert.run("2025-05-11", "ent-x", "mega-corp", 100, "alice",
      12, 9, 20, 60, 0, 50, 3, 0, 3, 0, 2, 0, 0, 1, 1, 0, 0, 0, 0,
      "[]", feature, "[]", "[]", "[]", null);

    insert.run("2025-05-11", "ent-y", "init-tech", 400, "frank",
      5, 3, 8, 25, 0, 18, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      "[]", feature, "[]", "[]", "[]", null);
  });

  it("COUNT(DISTINCT user_login) deduplicates daily active users across enterprises", () => {
    const rows = db.prepare(`
      SELECT
        day,
        COUNT(DISTINCT user_login) as daily
      FROM user_daily_metrics
      WHERE day = '2025-05-10'
        AND enterprise_slug IN ('mega-corp', 'init-tech')
      GROUP BY day
    `).all() as { day: string; daily: number }[];

    expect(rows).toHaveLength(1);
    // alice (x2 rows), dave, eve = 3 distinct users
    expect(rows[0].daily).toBe(3);
  });

  it("SUM of boolean flags double-counts overlapping users (the old bug)", () => {
    // This proves why SUM(used_cli) was wrong
    const row = db.prepare(`
      SELECT
        SUM(used_cli) as cli_sum,
        COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_id END) as cli_distinct
      FROM user_daily_metrics
      WHERE day = '2025-05-10'
        AND enterprise_slug IN ('mega-corp', 'init-tech')
    `).get() as { cli_sum: number; cli_distinct: number };

    // SUM would give 3 (alice*2 + eve), but distinct gives correct 2
    expect(row.cli_sum).toBe(3);     // WRONG: inflated
    expect(row.cli_distinct).toBe(2); // CORRECT: alice + eve
  });

  it("SUM of used_agent double-counts overlapping users (the old bug)", () => {
    const row = db.prepare(`
      SELECT
        SUM(used_agent) as agent_sum,
        COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_id END) as agent_distinct
      FROM user_daily_metrics
      WHERE day = '2025-05-10'
        AND enterprise_slug IN ('mega-corp', 'init-tech')
    `).get() as { agent_sum: number; agent_distinct: number };

    // alice has used_agent=1 in both enterprises → SUM=3, DISTINCT=2
    expect(row.agent_sum).toBe(3);     // WRONG: inflated
    expect(row.agent_distinct).toBe(2); // CORRECT: alice + eve
  });

  it("SUM of used_chat double-counts overlapping users (the old bug)", () => {
    const row = db.prepare(`
      SELECT
        SUM(used_chat) as chat_sum,
        COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_id END) as chat_distinct
      FROM user_daily_metrics
      WHERE day = '2025-05-10'
        AND enterprise_slug IN ('mega-corp', 'init-tech')
    `).get() as { chat_sum: number; chat_distinct: number };

    // alice has used_chat=1 in both, dave has used_chat=1 → SUM=3, DISTINCT=2
    expect(row.chat_sum).toBe(3);     // WRONG: inflated
    expect(row.chat_distinct).toBe(2); // CORRECT: alice + dave
  });

  it("rolling 7-day WAU correctly deduplicates across enterprises", () => {
    const rows = db.prepare(`
      SELECT
        m.day,
        COUNT(DISTINCT m.user_login) as daily,
        (SELECT COUNT(DISTINCT w.user_login)
         FROM user_daily_metrics w
         WHERE w.day BETWEEN date(m.day, '-6 days') AND m.day
           AND w.enterprise_slug IN ('mega-corp', 'init-tech')
        ) as weekly
      FROM user_daily_metrics m
      WHERE m.day >= '2025-05-10' AND m.day <= '2025-05-11'
        AND m.enterprise_slug IN ('mega-corp', 'init-tech')
      GROUP BY m.day
      ORDER BY m.day ASC
    `).all() as { day: string; daily: number; weekly: number }[];

    expect(rows).toHaveLength(2);
    // Day 1: daily=3 (alice, dave, eve), weekly=3
    expect(rows[0].daily).toBe(3);
    expect(rows[0].weekly).toBe(3);
    // Day 2: daily=2 (alice, frank), weekly=4 (alice, dave, eve, frank in 7-day window)
    expect(rows[1].daily).toBe(2);
    expect(rows[1].weekly).toBe(4);
  });

  it("rolling 30-day MAU correctly deduplicates across enterprises", () => {
    const rows = db.prepare(`
      SELECT
        m.day,
        (SELECT COUNT(DISTINCT mo.user_login)
         FROM user_daily_metrics mo
         WHERE mo.day BETWEEN date(m.day, '-29 days') AND m.day
           AND mo.enterprise_slug IN ('mega-corp', 'init-tech')
        ) as monthly
      FROM user_daily_metrics m
      WHERE m.day >= '2025-05-10' AND m.day <= '2025-05-11'
        AND m.enterprise_slug IN ('mega-corp', 'init-tech')
      GROUP BY m.day
      ORDER BY m.day ASC
    `).all() as { day: string; monthly: number }[];

    expect(rows).toHaveLength(2);
    // Day 1: 3 distinct users in 30-day window
    expect(rows[0].monthly).toBe(3);
    // Day 2: 4 distinct users (alice, dave, eve, frank)
    expect(rows[1].monthly).toBe(4);
  });

  it("adoption COUNT(DISTINCT) deduplicates across enterprises", () => {
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT user_login) as totalUsers,
        COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
        COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers,
        COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_login END) as chatUsers
      FROM user_daily_metrics
      WHERE day >= '2025-05-10' AND day <= '2025-05-11'
        AND enterprise_slug IN ('mega-corp', 'init-tech')
    `).get() as { totalUsers: number; agentUsers: number; cliUsers: number; chatUsers: number };

    // 4 distinct users across both days: alice, dave, eve, frank
    expect(row.totalUsers).toBe(4);
    // agent users: alice, eve (frank has used_agent=0)
    expect(row.agentUsers).toBe(2);
    // cli users: alice, eve (day1 only)
    expect(row.cliUsers).toBe(2);
    // chat users: alice, dave
    expect(row.chatUsers).toBe(2);
  });

  it("json_each aggregation sums activity across all enterprise rows", () => {
    const rows = db.prepare(`
      SELECT
        u.day,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
          THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as compGenCount,
        COALESCE(SUM(CASE WHEN ${IS_AGENT_SQL}
          THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as agentAdded
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day = '2025-05-10'
        AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
        AND u.enterprise_slug IN ('mega-corp', 'init-tech')
      GROUP BY u.day
    `).all() as { day: string; compGenCount: number; agentAdded: number }[];

    expect(rows).toHaveLength(1);
    // 4 rows × 20 code_generation from code_completion = 80
    expect(rows[0].compGenCount).toBe(80);
    // 4 rows × 30 agent_edit loc_added = 120
    expect(rows[0].agentAdded).toBe(120);
  });

  it("single-enterprise filter returns no cross-enterprise contamination", () => {
    const rows = db.prepare(`
      SELECT
        day,
        COUNT(DISTINCT user_login) as daily
      FROM user_daily_metrics
      WHERE day = '2025-05-10'
        AND enterprise_slug = 'mega-corp'
      GROUP BY day
    `).all() as { day: string; daily: number }[];

    // Only alice and dave in mega-corp
    expect(rows).toHaveLength(1);
    expect(rows[0].daily).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Copilot App classification tests
// Validates that `copilot_app` feature rows are never counted as
// completion (or agent) activity in the raw json_each SQL patterns.
// ═══════════════════════════════════════════════════════════════════════

describe("copilot_app SQL classification", () => {
  let appDb: Database;

  beforeAll(() => {
    appDb = new Database(":memory:");
    appDb.pragma("journal_mode = WAL");
    const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
    const summarySchemaPath = path.join(process.cwd(), "src", "lib", "db", "summary-schema.sql");
    appDb.exec(fs.readFileSync(schemaPath, "utf-8"));
    appDb.exec(fs.readFileSync(summarySchemaPath, "utf-8"));

    const features = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, loc_deleted_sum: 0, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
      { feature: "agent_edit", loc_suggested_to_add_sum: 0, loc_added_sum: 500, loc_deleted_sum: 200, code_generation_activity_count: 10, code_acceptance_activity_count: 0 },
      { feature: "copilot_app", loc_suggested_to_add_sum: 0, loc_added_sum: 60, loc_deleted_sum: 8, code_generation_activity_count: 7, code_acceptance_activity_count: 5 },
    ]);

    appDb.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_feature)
      VALUES ('2025-06-01', 'ent1', 'ent1', 1, 'user1', ?)`).run(features);
  });

  afterAll(() => {
    appDb.close();
  });

  it("explicit completion allowlist excludes copilot_app from completion sums", () => {
    const row = appDb.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as compGenCount,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as compAcceptCount
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day = '2025-06-01'
    `).get() as { completionAccepted: number; compGenCount: number; compAcceptCount: number };

    // Only code_completion counts — copilot_app (60 loc / 7 gen / 5 accept) must not leak in
    expect(row.completionAccepted).toBe(80);
    expect(row.compGenCount).toBe(50);
    expect(row.compAcceptCount).toBe(40);
  });

  it("IS_AGENT_SQL excludes copilot_app from agent sums", () => {
    const row = appDb.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ${IS_AGENT_SQL} THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as agentAdded
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day = '2025-06-01'
    `).get() as { agentAdded: number };

    expect(row.agentAdded).toBe(500);
  });

  it("IS_COPILOT_APP_SQL isolates App-only activity", () => {
    const row = appDb.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL} THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as appAdded,
        COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL} THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as appDeleted,
        COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL} THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as appGenCount,
        COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL} THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as appAcceptCount
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day = '2025-06-01'
    `).get() as { appAdded: number; appDeleted: number; appGenCount: number; appAcceptCount: number };

    expect(row.appAdded).toBe(60);
    expect(row.appDeleted).toBe(8);
    expect(row.appGenCount).toBe(7);
    expect(row.appAcceptCount).toBe(5);
  });

  it("chat_panel_* user-level modes still classify as completion", () => {
    const chatFeatures = JSON.stringify([
      { feature: "chat_panel_agent_mode", loc_added_sum: 15, code_generation_activity_count: 3, code_acceptance_activity_count: 2 },
      { feature: "copilot_app", loc_added_sum: 99, code_generation_activity_count: 99, code_acceptance_activity_count: 99 },
    ]);
    appDb.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_feature)
      VALUES ('2025-06-02', 'ent1', 'ent1', 2, 'user2', ?)`).run(chatFeatures);

    const row = appDb.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day = '2025-06-02'
    `).get() as { completionAccepted: number };

    // Only the chat_panel_agent_mode row (15) counts, copilot_app (99) excluded
    expect(row.completionAccepted).toBe(15);
  });

  it("excludes chat_inline and unknown/future feature names from the completion allowlist", () => {
    // `chat_inline` (a legacy/alternate name, distinct from `inline_chat`) and any
    // unrecognized feature must NOT be silently folded into completion — per the
    // authoritative semantics, only code_completion/inline_chat/chat_panel(_*) count.
    const mixedFeatures = JSON.stringify([
      { feature: "inline_chat", loc_added_sum: 25, code_generation_activity_count: 6, code_acceptance_activity_count: 4 },
      { feature: "chat_inline", loc_added_sum: 1000, code_generation_activity_count: 1000, code_acceptance_activity_count: 1000 },
      { feature: "some_future_unknown_feature", loc_added_sum: 2000, code_generation_activity_count: 2000, code_acceptance_activity_count: 2000 },
    ]);
    appDb.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_feature)
      VALUES ('2025-06-03', 'ent1', 'ent1', 3, 'user3', ?)`).run(mixedFeatures);

    const row = appDb.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as compGenCount,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as compAcceptCount
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day = '2025-06-03'
    `).get() as { completionAccepted: number; compGenCount: number; compAcceptCount: number };

    // Only inline_chat (25/6/4) counts — chat_inline and the unknown feature must be excluded entirely
    expect(row.completionAccepted).toBe(25);
    expect(row.compGenCount).toBe(6);
    expect(row.compAcceptCount).toBe(4);
  });

  it("NOT_AGENT_OR_APP_SQL keeps legacy rows with no feature key in broad (non-completion-rate) views", () => {
    // Older synced data may have language rows with no `feature` key at all.
    // The broad/backward-compatible exclusion (NOT_AGENT_OR_APP_SQL) must still
    // include these — only agent_edit/copilot_app are excluded, unlike the
    // stricter completion allowlist used for the completion rate itself.
    const legacyLangFeature = JSON.stringify([
      { language: "Rust", loc_added_sum: 40, loc_suggested_to_add_sum: 50, code_generation_activity_count: 4, code_acceptance_activity_count: 3 },
    ]);
    appDb.prepare(`INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, totals_by_language_feature)
      VALUES ('2025-06-04', 'ent1', 'ent1', 4, 'user4', ?)`).run(legacyLangFeature);

    const row = appDb.prepare(`
      SELECT
        COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) as locAdded
      FROM user_daily_metrics u, json_each(u.totals_by_language_feature) j
      WHERE u.day = '2025-06-04'
        AND ${NOT_AGENT_OR_APP_SQL}
    `).get() as { locAdded: number };

    expect(row.locAdded).toBe(40);
  });
});
