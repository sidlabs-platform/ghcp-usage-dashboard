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
