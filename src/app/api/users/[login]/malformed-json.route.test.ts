// Integration-style tests against a real (in-memory) SQLite database proving
// the user detail route survives malformed JSON in totals_by_feature and
// totals_by_language_feature. Prior to the json_valid() guards, a single bad
// row in either column would make json_each() throw a "malformed JSON" SQLite
// error, which propagated as an unhandled exception and 500'd the whole
// route — even though most rows for the user/period were perfectly valid.
//
// getCompletionDailyTrend (src/lib/db/aggregation-queries.ts) runs its own
// json_each(totals_by_feature) query and is invoked directly by this route
// for the per-day completion trend, so it is exercised here for real (not
// stubbed) — it is guarded with json_valid the same as the route-local
// queries, proven separately (and more granularly) in
// src/lib/db/aggregation-functions.test.ts.
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

function insertRow(day: string, totalsByFeature: string | null, totalsByLanguageFeature: string | null) {
  db.prepare(`
    INSERT INTO user_daily_metrics (
      day, enterprise_id, enterprise_slug, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count,
      user_initiated_interaction_count, ai_credits_used,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      totals_by_feature, totals_by_language_feature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    day, "ent1", "ent1", 1, "octocat",
    100, 80, 10, 0,
    100, 0, 100, 10,
    totalsByFeature, totalsByLanguageFeature,
  );
}

describe("user detail route — malformed JSON resilience", { timeout: 10000 }, () => {
  it("does not 500 when totals_by_feature is malformed on one day, and still aggregates the valid day", async () => {
    const validFeature = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, loc_deleted_sum: 0, code_generation_activity_count: 50, code_acceptance_activity_count: 40, user_initiated_interaction_count: 5 },
    ]);
    const validLanguageFeature = JSON.stringify([
      { language: "TypeScript", feature: "code_completion", code_generation_activity_count: 10, code_acceptance_activity_count: 8 },
    ]);

    insertRow("2024-03-01", validFeature, validLanguageFeature);
    // Malformed totals_by_feature (truncated/invalid JSON) on a second day.
    insertRow("2024-03-02", "{not valid json", validLanguageFeature);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/users/octocat?startDate=2024-03-01&endDate=2024-03-02",
    ));

    expect(res.status).toBe(200);
    const json = await res.json();

    // Only the valid day's totals_by_feature row contributes.
    expect(json.summary.totalLocSuggested).toBe(100);
    expect(json.summary.completionLocAccepted).toBe(80);
    const featureNames = json.featureUsage.map((f: { feature: string }) => f.feature);
    expect(featureNames).toEqual(["code_completion"]);

    // dailyActivity's completionLoc* fields are populated by the real
    // (unstubbed) getCompletionDailyTrend, which runs its own separate
    // json_each(totals_by_feature) query — this proves that call site is
    // also guarded, since malformed JSON there would otherwise throw before
    // any of the above is ever reached.
    const validDay = json.dailyActivity.find((d: { day: string }) => d.day === "2024-03-01");
    const malformedDay = json.dailyActivity.find((d: { day: string }) => d.day === "2024-03-02");
    expect(validDay.completionLocSuggested).toBe(100);
    expect(validDay.completionLocAccepted).toBe(80);
    // The malformed day's own totals_by_feature row is skipped (no joined
    // json_each rows), so its completion trend fields default to 0 — the row
    // itself still comes through from the plain (non-JSON) daily query.
    expect(malformedDay.completionLocSuggested).toBe(0);
    expect(malformedDay.completionLocAccepted).toBe(0);
  });

  it("does not 500 when totals_by_language_feature is malformed on one day, and still aggregates the valid day", async () => {
    const validFeature = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, loc_deleted_sum: 0, code_generation_activity_count: 50, code_acceptance_activity_count: 40, user_initiated_interaction_count: 5 },
    ]);
    const validLanguageFeature = JSON.stringify([
      { language: "TypeScript", feature: "code_completion", code_generation_activity_count: 10, code_acceptance_activity_count: 8 },
    ]);

    insertRow("2024-03-01", validFeature, validLanguageFeature);
    // Malformed totals_by_language_feature on a second day.
    insertRow("2024-03-02", validFeature, "[{broken");

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/users/octocat?startDate=2024-03-01&endDate=2024-03-02",
    ));

    expect(res.status).toBe(200);
    const json = await res.json();

    // Only the valid day's totals_by_language_feature row contributes.
    expect(json.topLanguages).toEqual([
      { language: "TypeScript", suggestions: 10, acceptances: 8 },
    ]);
  });
});
