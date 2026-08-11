// Integration-style tests against a real (in-memory) SQLite database proving
// the user detail route's completion metrics use the explicit completion
// allowlist (code_completion, inline_chat, chat_panel, chat_panel_*) — NOT a
// bare `!= 'agent_edit'` exclusion. `copilot_app` and `chat_inline`/unknown
// features must never enter completion acceptance/LoC, while inline_chat and
// chat_panel_* modes must.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import Database from "@/lib/db/sqlite-database";
import path from "path";
import fs from "fs";

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

describe("user detail route — completion allowlist", { timeout: 10000 }, () => {
  it("excludes copilot_app and chat_inline/unknown from completion LoC/acceptance (summary), while topLanguages uses the NOT_AGENT_OR_APP_SQL exclusion (matches getLanguageBreakdown)", async () => {
    const totalsByFeature = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, loc_deleted_sum: 0, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
      { feature: "inline_chat", loc_suggested_to_add_sum: 30, loc_added_sum: 25, loc_deleted_sum: 0, code_generation_activity_count: 6, code_acceptance_activity_count: 4 },
      { feature: "chat_panel_agent_mode", loc_suggested_to_add_sum: 0, loc_added_sum: 15, loc_deleted_sum: 0, code_generation_activity_count: 3, code_acceptance_activity_count: 2 },
      { feature: "agent_edit", loc_suggested_to_add_sum: 0, loc_added_sum: 500, loc_deleted_sum: 200, code_generation_activity_count: 10, code_acceptance_activity_count: 0 },
      { feature: "copilot_app", loc_suggested_to_add_sum: 0, loc_added_sum: 60, loc_deleted_sum: 8, code_generation_activity_count: 7, code_acceptance_activity_count: 5 },
      { feature: "chat_inline", loc_suggested_to_add_sum: 1000, loc_added_sum: 1000, loc_deleted_sum: 0, code_generation_activity_count: 1000, code_acceptance_activity_count: 1000 },
      { feature: "some_future_unknown_feature", loc_suggested_to_add_sum: 2000, loc_added_sum: 2000, loc_deleted_sum: 0, code_generation_activity_count: 2000, code_acceptance_activity_count: 2000 },
    ]);

    const totalsByLanguageFeature = JSON.stringify([
      { language: "TypeScript", feature: "code_completion", code_generation_activity_count: 10, code_acceptance_activity_count: 8 },
      { language: "TypeScript", feature: "copilot_app", code_generation_activity_count: 500, code_acceptance_activity_count: 500 },
      { language: "TypeScript", feature: "chat_inline", code_generation_activity_count: 900, code_acceptance_activity_count: 900 },
      { language: "Python", feature: "inline_chat", code_generation_activity_count: 5, code_acceptance_activity_count: 3 },
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
      "2024-02-01", "ent1", "ent1", 1, "octocat",
      3076, 3051, 10, 0,
      3130, 0, 3680, 208,
      totalsByFeature, totalsByLanguageFeature,
    );

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/users/octocat?startDate=2024-02-01&endDate=2024-02-01",
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    // Completion sums: code_completion (50/40/100/80) + inline_chat (6/4/30/25)
    // + chat_panel_agent_mode (3/2/0/15) — copilot_app, chat_inline, and the
    // unknown feature (huge values, would dominate if leaked) must be excluded.
    expect(json.summary.totalLocSuggested).toBe(130); // 100 + 30 + 0
    expect(json.summary.completionLocAccepted).toBe(120); // 80 + 25 + 15
    // compGenCount = 50 + 6 + 3 = 59; compAcceptCount = 40 + 4 + 2 = 46
    // rate = 46/59*100 = 77.9661... -> rounded to 1 decimal = 78
    expect(json.summary.completionAcceptanceRate).toBe(78);

    // Top languages use NOT_AGENT_OR_APP_SQL (exclusion), NOT the strict
    // IS_COMPLETION_SQL allowlist — matching getLanguageBreakdown/
    // getLanguageByFeatureBreakdown in aggregation-queries.ts. Only copilot_app
    // (agent_edit/copilot_app) is excluded; chat_inline is NOT a recognized
    // completion feature but is also not agent_edit/copilot_app, so (unlike the
    // strict summary.completionLocAccepted above) it IS included here.
    const ts = json.topLanguages.find((l: { language: string }) => l.language === "TypeScript");
    const py = json.topLanguages.find((l: { language: string }) => l.language === "Python");
    expect(ts).toEqual({ language: "TypeScript", suggestions: 910, acceptances: 908 }); // code_completion(10/8) + chat_inline(900/900); copilot_app(500/500) excluded
    expect(py).toEqual({ language: "Python", suggestions: 5, acceptances: 3 });

    // Broad feature view (featureUsage) is unfiltered and may still show
    // copilot_app/chat_inline/unknown rows — they just must not enter completion.
    const featureNames = json.featureUsage.map((f: { feature: string }) => f.feature);
    expect(featureNames).toEqual(expect.arrayContaining(["copilot_app", "chat_inline", "some_future_unknown_feature"]));
  });
});
