// Integration-style tests (real in-memory SQLite, matching the pattern in
// completion-allowlist.route.test.ts) proving the user detail route's
// Copilot App attribution: `summary.usedCopilotApp` correctly distinguishes
// availability vs activity, `copilotAppStats` combines the dedicated
// `totals_by_copilot_app` totals with the `copilot_app` totals_by_feature
// entry via the shared getCopilotAppUserSummary query helper, multi-enterprise
// duplicate rows are deduped (MAX before SUM), and completion metrics never
// include copilot_app-seeded activity.
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

interface InsertRowOptions {
  day: string;
  enterpriseId: string;
  enterpriseSlug: string;
  login: string;
  usedCopilotApp: number | null;
  totalsByCopilotApp: string | null;
  totalsByFeature: string;
}

function insertRow(opts: InsertRowOptions): void {
  db.prepare(`
    INSERT INTO user_daily_metrics (
      day, enterprise_id, enterprise_slug, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count,
      user_initiated_interaction_count, ai_credits_used,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      used_copilot_app, totals_by_copilot_app, totals_by_feature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.day, opts.enterpriseId, opts.enterpriseSlug, 1, opts.login,
    10, 8, 5, 0,
    20, 0, 18, 0,
    opts.usedCopilotApp, opts.totalsByCopilotApp, opts.totalsByFeature,
  );
}

async function fetchUser(login: string, startDate: string, endDate: string) {
  const GET = await getHandler();
  const res = await GET(new NextRequest(
    `http://localhost/api/users/${login}?startDate=${startDate}&endDate=${endDate}`,
  ));
  return { status: res.status, json: await res.json() };
}

describe("user detail route — Copilot App attribution", { timeout: 10000 }, () => {
  it("returns exact copilotAppStats fields and usedCopilotApp: true when App activity exists", async () => {
    const totalsByCopilotApp = JSON.stringify({
      session_count: 4,
      request_count: 10,
      prompt_count: 12,
      token_usage: { prompt_tokens_sum: 500, output_tokens_sum: 300 },
    });
    const totalsByFeature = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, loc_deleted_sum: 0, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
      { feature: "copilot_app", loc_suggested_to_add_sum: 0, loc_added_sum: 60, loc_deleted_sum: 8, code_generation_activity_count: 7, code_acceptance_activity_count: 5 },
    ]);
    insertRow({
      day: "2024-03-01", enterpriseId: "ent1", enterpriseSlug: "ent1", login: "octocat",
      usedCopilotApp: 1, totalsByCopilotApp, totalsByFeature,
    });

    const { status, json } = await fetchUser("octocat", "2024-03-01", "2024-03-01");
    expect(status).toBe(200);

    expect(json.summary.usedCopilotApp).toBe(true);
    expect(json.copilotAppStats).toEqual({
      sessions: 4,
      requests: 10,
      prompts: 12,
      promptTokens: 500,
      outputTokens: 300,
      avgTokensPerRequest: 80, // (500 + 300) / 10
      codeGenerations: 7,
      codeAcceptances: 5,
      locAdded: 60,
      locDeleted: 8,
    });

    // The copilot_app feature row's LoC (60 added) must never leak into the
    // strict completion-only summary fields (code_completion-only: 100/80).
    expect(json.summary.totalLocSuggested).toBe(100);
    expect(json.summary.completionLocAccepted).toBe(80);
  });

  it("computes avgTokensPerRequest as a weighted average across days, not an average of daily ratios", async () => {
    // Day 1: 100 tokens / 10 requests = 10/req. Day 2: 900 tokens / 10 requests = 90/req.
    // A naive average-of-averages would give (10 + 90) / 2 = 50. The correct
    // weighted total is (100 + 900) / (10 + 10) = 1000 / 20 = 50 as well by
    // coincidence of these numbers being symmetric — use asymmetric request
    // counts instead so the two approaches diverge.
    insertRow({
      day: "2024-03-01", enterpriseId: "ent1", enterpriseSlug: "ent1", login: "octocat",
      usedCopilotApp: 1,
      totalsByCopilotApp: JSON.stringify({
        session_count: 1, request_count: 20, prompt_count: 20,
        token_usage: { prompt_tokens_sum: 100, output_tokens_sum: 0 },
      }),
      totalsByFeature: "[]",
    });
    insertRow({
      day: "2024-03-02", enterpriseId: "ent1", enterpriseSlug: "ent1", login: "octocat",
      usedCopilotApp: 1,
      totalsByCopilotApp: JSON.stringify({
        session_count: 1, request_count: 5, prompt_count: 5,
        token_usage: { prompt_tokens_sum: 500, output_tokens_sum: 0 },
      }),
      totalsByFeature: "[]",
    });

    const { json } = await fetchUser("octocat", "2024-03-01", "2024-03-02");
    // Weighted: (100 + 500) / (20 + 5) = 600 / 25 = 24.
    // Average-of-daily-averages would incorrectly give (5 + 100) / 2 = 52.5.
    expect(json.copilotAppStats.avgTokensPerRequest).toBe(24);
    expect(json.copilotAppStats.requests).toBe(25);
    expect(json.copilotAppStats.promptTokens).toBe(600);
  });

  it("dedupes duplicate enterprise rows for the same user/day before summing (MAX, not SUM)", async () => {
    const totalsByCopilotApp = JSON.stringify({
      session_count: 3, request_count: 6, prompt_count: 6,
      token_usage: { prompt_tokens_sum: 60, output_tokens_sum: 40 },
    });
    const totalsByFeature = JSON.stringify([
      { feature: "copilot_app", loc_suggested_to_add_sum: 0, loc_added_sum: 15, loc_deleted_sum: 2, code_generation_activity_count: 4, code_acceptance_activity_count: 3 },
    ]);
    // Same user/day duplicated across two enterprises with identical values —
    // a naive SUM across enterprise rows would double every count.
    insertRow({ day: "2024-03-01", enterpriseId: "acme", enterpriseSlug: "acme", login: "octocat", usedCopilotApp: 1, totalsByCopilotApp, totalsByFeature });
    insertRow({ day: "2024-03-01", enterpriseId: "beta", enterpriseSlug: "beta", login: "octocat", usedCopilotApp: 1, totalsByCopilotApp, totalsByFeature });

    const { json } = await fetchUser("octocat", "2024-03-01", "2024-03-01");
    expect(json.copilotAppStats).toEqual({
      sessions: 3,
      requests: 6,
      prompts: 6,
      promptTokens: 60,
      outputTokens: 40,
      avgTokensPerRequest: 16.7, // (60 + 40) / 6 = 16.666... rounded to 1 decimal
      codeGenerations: 4,
      codeAcceptances: 3,
      locAdded: 15,
      locDeleted: 2,
    });
  });

  it("infers usedCopilotApp: true from actual App activity even when the used_copilot_app flag is missing", async () => {
    // used_copilot_app is NULL (missing/stale flag), but totals_by_copilot_app
    // carries real activity — actual data evidence must win over the flag.
    insertRow({
      day: "2024-03-01", enterpriseId: "ent1", enterpriseSlug: "ent1", login: "octocat",
      usedCopilotApp: null,
      totalsByCopilotApp: JSON.stringify({
        session_count: 2, request_count: 4, prompt_count: 4,
        token_usage: { prompt_tokens_sum: 40, output_tokens_sum: 20 },
      }),
      totalsByFeature: "[]",
    });

    const { json } = await fetchUser("octocat", "2024-03-01", "2024-03-01");
    expect(json.summary.usedCopilotApp).toBe(true);
    expect(json.copilotAppStats.sessions).toBe(2);
  });

  it("returns usedCopilotApp: false with zero-value copilotAppStats when App is supported but never used", async () => {
    // used_copilot_app explicitly false, dedicated totals present but all
    // zero, no copilot_app feature row — "supported", not "no evidence".
    insertRow({
      day: "2024-03-01", enterpriseId: "ent1", enterpriseSlug: "ent1", login: "octocat",
      usedCopilotApp: 0,
      totalsByCopilotApp: JSON.stringify({
        session_count: 0, request_count: 0, prompt_count: 0,
        token_usage: { prompt_tokens_sum: 0, output_tokens_sum: 0 },
      }),
      totalsByFeature: "[]",
    });

    const { json } = await fetchUser("octocat", "2024-03-01", "2024-03-01");
    expect(json.summary.usedCopilotApp).toBe(false);
    expect(json.copilotAppStats).toEqual({
      sessions: 0,
      requests: 0,
      prompts: 0,
      promptTokens: 0,
      outputTokens: 0,
      avgTokensPerRequest: 0,
      codeGenerations: 0,
      codeAcceptances: 0,
      locAdded: 0,
      locDeleted: 0,
    });
  });

  it("returns null usedCopilotApp and null copilotAppStats when no App support evidence exists at all (legacy data)", async () => {
    // No used_copilot_app flag, no totals_by_copilot_app, no copilot_app
    // feature row — legacy data synced before Copilot App tracking existed.
    insertRow({
      day: "2024-03-01", enterpriseId: "ent1", enterpriseSlug: "ent1", login: "octocat",
      usedCopilotApp: null, totalsByCopilotApp: null,
      totalsByFeature: JSON.stringify([
        { feature: "code_completion", loc_suggested_to_add_sum: 10, loc_added_sum: 8, loc_deleted_sum: 0, code_generation_activity_count: 5, code_acceptance_activity_count: 4 },
      ]),
    });

    const { json } = await fetchUser("octocat", "2024-03-01", "2024-03-01");
    expect(json.summary.usedCopilotApp).toBeNull();
    expect(json.copilotAppStats).toBeNull();
  });
});
