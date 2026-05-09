import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// We test the SQL queries directly against a temporary in-memory DB
// to verify json_each aggregation logic

let db: Database.Database;

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
        COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') != 'agent_edit'
          THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as completionSuggested,
        COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') != 'agent_edit'
          THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
        COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') = 'agent_edit'
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
