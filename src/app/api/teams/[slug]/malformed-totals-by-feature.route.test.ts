// Integration-style regression test against a real (in-memory) SQLite
// database proving the team detail route's per-member completion rate
// query survives a legacy/corrupted `totals_by_feature` value. SQLite's
// json_each() throws "malformed JSON" for any non-empty, non-null string
// that isn't valid JSON — `IS NOT NULL AND totals_by_feature != '[]'`
// does not guard against that. The query must add json_valid(...) so one
// bad row doesn't 500 the whole team detail response.
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
  db.exec("DELETE FROM team_memberships");
});

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

describe("team detail route — malformed totals_by_feature resilience", { timeout: 10000 }, () => {
  it("does not 500 when a team member's totals_by_feature is malformed JSON", async () => {
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'platform', 'Platform', 'org', 'octo-org', 'octocat', '2024-02-01T00:00:00Z')
    `).run();

    // Legacy/corrupted row: not valid JSON (truncated array), but non-null
    // and not the empty-array sentinel, so the existing
    // `IS NOT NULL AND totals_by_feature != '[]'` guard lets it through to
    // json_each(), where SQLite raises "malformed JSON".
    const malformedTotalsByFeature = '[{"feature": "code_completion", "loc_added_sum": 10';

    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        loc_added_sum, user_initiated_interaction_count,
        used_agent, used_chat, used_cli, used_copilot_code_review_active,
        totals_by_feature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2024-02-01", "ent1", "ent1", 1, "octocat",
      100, 5,
      0, 1, 0, 0,
      malformedTotalsByFeature,
    );

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/teams/platform?startDate=2024-02-01&endDate=2024-02-01",
    ));

    expect(res.status).toBe(200);
    const json = await res.json();

    const member = json.members.find((m: { login: string }) => m.login === "octocat");
    expect(member).toBeDefined();
    // The malformed row is skipped for the completion-rate calculation, so
    // acceptanceRate falls back to 0 rather than the request failing.
    expect(member.acceptanceRate).toBe(0);
    // Non-JSON-derived member metrics (from the separate member_metrics CTE)
    // must remain unaffected by the malformed totals_by_feature value.
    expect(member.locAdded).toBe(100);
  });
});
