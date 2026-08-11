// Integration-style tests against a real (in-memory) SQLite database proving
// the team detail route's per-member completion acceptance rate uses the
// explicit completion allowlist (code_completion, inline_chat, chat_panel,
// chat_panel_*) — NOT a bare `!= 'agent_edit'` exclusion. `copilot_app` and
// `chat_inline`/unknown features must never enter a team member's completion
// acceptance rate.
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

describe("team detail route — completion allowlist", { timeout: 10000 }, () => {
  it("excludes copilot_app and chat_inline/unknown from a member's completion acceptance rate while including inline_chat/chat_panel_*", async () => {
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'platform', 'Platform', 'org', 'octo-org', 'octocat', '2024-02-01T00:00:00Z')
    `).run();

    const totalsByFeature = JSON.stringify([
      { feature: "code_completion", loc_added_sum: 80, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
      { feature: "inline_chat", loc_added_sum: 25, code_generation_activity_count: 6, code_acceptance_activity_count: 4 },
      { feature: "chat_panel_agent_mode", loc_added_sum: 15, code_generation_activity_count: 3, code_acceptance_activity_count: 2 },
      { feature: "agent_edit", loc_added_sum: 500, code_generation_activity_count: 10, code_acceptance_activity_count: 0 },
      { feature: "copilot_app", loc_added_sum: 60, code_generation_activity_count: 7, code_acceptance_activity_count: 5 },
      { feature: "chat_inline", loc_added_sum: 1000, code_generation_activity_count: 1000, code_acceptance_activity_count: 1000 },
      { feature: "some_future_unknown_feature", loc_added_sum: 2000, code_generation_activity_count: 2000, code_acceptance_activity_count: 2000 },
    ]);

    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        loc_added_sum, user_initiated_interaction_count,
        used_agent, used_chat, used_cli, used_copilot_code_review_active,
        totals_by_feature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2024-02-01", "ent1", "ent1", 1, "octocat",
      3680, 10,
      1, 1, 0, 0,
      totalsByFeature,
    );

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/teams/platform?startDate=2024-02-01&endDate=2024-02-01",
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    const member = json.members.find((m: { login: string }) => m.login === "octocat");
    expect(member).toBeDefined();

    // comp_gen = 50 + 6 + 3 = 59; comp_accept = 40 + 4 + 2 = 46
    // rate = ROUND(46/59*100, 1) = 78.0 — copilot_app/chat_inline/unknown
    // (much larger counts) must NOT shift this rate.
    expect(member.acceptanceRate).toBe(78);
  });
});
