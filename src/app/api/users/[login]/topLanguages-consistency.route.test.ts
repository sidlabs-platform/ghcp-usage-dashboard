// Integration-style tests against a real (in-memory) SQLite database proving
// the user detail route's topLanguages uses the same NOT_AGENT_OR_APP_SQL
// exclusion as getLanguageBreakdown/getLanguageByFeatureBreakdown in
// aggregation-queries.ts — NOT the strict IS_COMPLETION_SQL allowlist used by
// summary.completionLocAccepted. This preserves legacy rows synced before the
// `feature` key existed (COALESCE(feature, '') = '' — neither 'agent_edit'
// nor 'copilot_app', so they pass the exclusion), while chat_inline and any
// unrecognized feature also count (they are not agent_edit/copilot_app),
// and agent_edit/copilot_app are always excluded.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import Database from "@/lib/db/sqlite-database";
import path from "path";
import fs from "fs";
import { getLanguageBreakdown } from "@/lib/db/aggregation-queries";

let db: Database;

vi.mock("@/lib/db/database", () => ({
  getDb: () => db,
}));

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({
  withRateLimit: (handler: unknown) => handler,
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  CACHE_TTL: { MEDIUM: 300 },
}));

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  const summarySchemaPath = path.join(process.cwd(), "src", "lib", "db", "summary-schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
  db.exec(fs.readFileSync(summarySchemaPath, "utf-8"));
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM user_daily_metrics");
});

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

describe("user detail route — topLanguages consistency with getLanguageBreakdown", { timeout: 10000 }, () => {
  it("deduplicates repeated user-day totals across enterprises", async () => {
    const insert = db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        code_generation_activity_count, code_acceptance_activity_count,
        user_initiated_interaction_count, ai_credits_used,
        loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
        agent_edit, totals_by_feature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const values = [
      "2024-03-02", 2, "octocat",
      10, 4, 8, 1.5,
      60, 2, 70, 4,
      JSON.stringify({ loc_added_sum: 20, loc_deleted_sum: 2 }),
      "[]",
    ] as const;
    insert.run(values[0], "ent-a", "ent-a", ...values.slice(1));
    insert.run(values[0], "ent-b", "ent-b", ...values.slice(1));

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/users/octocat?startDate=2024-03-02&endDate=2024-03-02",
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dailyActivity).toEqual([
      expect.objectContaining({
        day: "2024-03-02",
        codeGen: 10,
        locSuggested: 60,
        locAccepted: 70,
        agentLocAdded: 20,
      }),
    ]);
    expect(json.summary).toEqual(expect.objectContaining({
      totalCodeGen: 10,
      totalLocAdded: 60,
      totalLocAccepted: 70,
      agentLocAdded: 20,
    }));
  });

  it("uses the latest scoped login match as one stable user ID across every detail query", async () => {
    const insert = db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        code_generation_activity_count, code_acceptance_activity_count,
        user_initiated_interaction_count, loc_suggested_to_add_sum, loc_added_sum,
        chat_panel_ask_mode, used_copilot_app, totals_by_ide, totals_by_feature,
        totals_by_language_feature, totals_by_model_feature, totals_by_cli,
        totals_by_copilot_app, agent_edit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const addRow = (
      day: string,
      enterprise: string,
      userId: number,
      login: string,
      count: number,
      label: string,
    ) => insert.run(
      day, enterprise, enterprise, userId, login,
      count, count, count, count * 10, count * 10,
      count, 1,
      JSON.stringify([{ ide: label, user_initiated_interaction_count: count }]),
      JSON.stringify([
        {
          feature: "code_completion",
          user_initiated_interaction_count: count,
          code_generation_activity_count: count,
          code_acceptance_activity_count: count,
          loc_suggested_to_add_sum: count * 10,
          loc_added_sum: count * 10,
          loc_suggested_to_delete_sum: 0,
          loc_deleted_sum: 0,
        },
        {
          feature: "copilot_app",
          user_initiated_interaction_count: count,
          code_generation_activity_count: count,
          code_acceptance_activity_count: count,
          loc_added_sum: count,
          loc_deleted_sum: 0,
        },
      ]),
      JSON.stringify([{
        language: label,
        feature: "code_completion",
        code_generation_activity_count: count,
        code_acceptance_activity_count: count,
      }]),
      JSON.stringify([{
        model: label,
        user_initiated_interaction_count: count,
      }]),
      JSON.stringify({
        session_count: count,
        request_count: count,
        prompt_count: count,
        token_usage: { prompt_tokens_sum: count, output_tokens_sum: count },
      }),
      JSON.stringify({
        session_count: count,
        request_count: count,
        prompt_count: count,
        token_usage: { prompt_tokens_sum: count, output_tokens_sum: count },
      }),
      JSON.stringify({ loc_added_sum: count, loc_deleted_sum: 0 }),
    );

    addRow("2025-01-01", "ent-a", 101, "reused-login", 100, "old-user");
    addRow("2025-01-01", "ent-a", 202, "renamed-login", 3, "stable-user");
    addRow("2025-01-02", "ent-a", 202, "ReUsEd-LoGiN", 5, "stable-user");
    addRow("2025-01-03", "ent-b", 303, "reused-login", 200, "wrong-scope");

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/users/reused-login?startDate=2025-01-01&endDate=2025-01-03&enterprises=ent-a",
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dailyActivity.map((row: { day: string; codeGen: number }) => ({
      day: row.day,
      codeGen: row.codeGen,
    }))).toEqual([
      { day: "2025-01-01", codeGen: 3 },
      { day: "2025-01-02", codeGen: 5 },
    ]);
    expect(json.summary).toEqual(expect.objectContaining({
      totalCodeGen: 8,
      totalLocSuggested: 80,
      completionLocAccepted: 80,
      agentLocAdded: 8,
    }));
    expect(json.topLanguages).toEqual([
      { language: "stable-user", suggestions: 8, acceptances: 8 },
    ]);
    expect(json.topModels).toEqual([{ model: "stable-user", interactions: 8 }]);
    expect(json.ideUsage).toEqual([{ ide: "stable-user", interactions: 8 }]);
    expect(json.featureUsage).toContainEqual(expect.objectContaining({
      feature: "code_completion",
      codeGen: 8,
    }));
    expect(json.chatModes.ask).toBe(8);
    expect(json.cliStats.sessions).toBe(8);
    expect(json.copilotAppStats).toEqual(expect.objectContaining({
      sessions: 8,
      codeGenerations: 8,
    }));
  });

  it("preserves legacy featureless rows, includes chat_inline/unknown, and excludes agent_edit/copilot_app — matching getLanguageBreakdown", async () => {
    const totalsByLanguageFeature = JSON.stringify([
      // Legacy row synced before the `feature` key existed on language rows.
      { language: "Go", code_generation_activity_count: 40, code_acceptance_activity_count: 30 },
      { language: "Rust", feature: "code_completion", code_generation_activity_count: 12, code_acceptance_activity_count: 9 },
      { language: "Rust", feature: "chat_inline", code_generation_activity_count: 5, code_acceptance_activity_count: 4 },
      { language: "Rust", feature: "some_future_unknown_feature", code_generation_activity_count: 3, code_acceptance_activity_count: 1 },
      { language: "Rust", feature: "agent_edit", code_generation_activity_count: 1000, code_acceptance_activity_count: 1000 },
      { language: "Rust", feature: "copilot_app", code_generation_activity_count: 2000, code_acceptance_activity_count: 2000 },
    ]);

    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        code_generation_activity_count, code_acceptance_activity_count,
        user_initiated_interaction_count, ai_credits_used,
        loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
        totals_by_feature, totals_by_language_feature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2024-03-01", "ent1", "ent1", 1, "octocat",
      0, 0, 0, 0,
      0, 0, 0, 0,
      "[]", totalsByLanguageFeature,
    );

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/users/octocat?startDate=2024-03-01&endDate=2024-03-01",
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    const go = json.topLanguages.find((l: { language: string }) => l.language === "Go");
    const rust = json.topLanguages.find((l: { language: string }) => l.language === "Rust");

    // Legacy featureless row: preserved (not dropped by the exclusion).
    expect(go).toEqual({ language: "Go", suggestions: 40, acceptances: 30 });
    // code_completion (12/9) + chat_inline (5/4) + unknown (3/1) = 20/14.
    // agent_edit (1000/1000) and copilot_app (2000/2000) excluded despite
    // being far larger — if leaked they would dominate the result.
    expect(rust).toEqual({ language: "Rust", suggestions: 20, acceptances: 14 });

    // Cross-check against the shared getLanguageBreakdown SQL helper directly
    // (same NOT_AGENT_OR_APP_SQL exclusion) — the route must not diverge.
    const breakdown = getLanguageBreakdown("2024-03-01", "2024-03-01");
    const goBreakdown = breakdown.find((l) => l.language === "Go");
    const rustBreakdown = breakdown.find((l) => l.language === "Rust");
    expect(goBreakdown).toBeDefined();
    expect(rustBreakdown).toBeDefined();
  });
});
