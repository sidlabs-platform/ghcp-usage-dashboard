// Regression coverage proving the overview route's completion acceptance
// rate is unaffected by copilot_app/chat_inline/unknown feature rows, in
// both code paths it can take: the SQL-aggregated path (getCompletionDailyTrend,
// used when filters are active or enterprise data is unavailable) and the
// enterprise-level path (extractCompletionMetrics from separate-metrics.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import Database from "@/lib/db/sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

const mockGetOverviewKPIs = vi.hoisted(() =>
  vi.fn(() => ({
    totalNet: 0,
    totalGross: 0,
    totalDiscount: 0,
    uniqueProducts: 0,
    uniqueOrgs: 0,
    userChargesNet: 0,
    orgChargesNet: 0,
  })),
);

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

vi.mock("@/lib/db/billing-repo", () => ({
  getOverviewKPIs: mockGetOverviewKPIs,
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
  mockGetOverviewKPIs.mockClear();
  mockGetOverviewKPIs.mockReturnValue({
    totalNet: 0,
    totalGross: 0,
    totalDiscount: 0,
    uniqueProducts: 0,
    uniqueOrgs: 0,
    userChargesNet: 0,
    orgChargesNet: 0,
  });
  db.exec("DELETE FROM user_daily_metrics");
  db.exec("DELETE FROM enterprise_daily_metrics");
  db.exec("DELETE FROM team_memberships");
  db.exec("DELETE FROM copilot_seats");
});

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

describe("overview route — explicit date range regression", () => {
  it("loads only data inside the selected calendar range", async () => {
    const { upsertEnterpriseDayMetrics } = await import("@/lib/db/metrics-repo");
    const totals_by_feature = [
      {
        feature: "code_completion",
        code_generation_activity_count: 10,
        code_acceptance_activity_count: 5,
        loc_added_sum: 5,
        loc_deleted_sum: 0,
        loc_suggested_to_add_sum: 10,
        loc_suggested_to_delete_sum: 0,
        user_initiated_interaction_count: 0,
      },
    ];

    for (const [day, users] of [["2026-06-30", 99], ["2026-07-01", 3], ["2026-07-31", 7]] as const) {
      upsertEnterpriseDayMetrics("ent1", {
        day,
        enterprise_id: "ent1",
        daily_active_users: users,
        weekly_active_users: users,
        monthly_active_users: users,
        monthly_active_agent_users: 0,
        monthly_active_chat_users: 0,
        daily_active_cli_users: 0,
        daily_active_copilot_app_users: null,
        code_generation_activity_count: 10,
        code_acceptance_activity_count: 5,
        user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 10,
        loc_suggested_to_delete_sum: 0,
        loc_added_sum: 5,
        loc_deleted_sum: 0,
        totals_by_ide: [],
        totals_by_feature,
        totals_by_language_feature: [],
        totals_by_model_feature: [],
        totals_by_language_model: [],
      });

    }

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?startDate=2026-07-01&endDate=2026-07-31",
    ));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeUsersTrend.map((row: { day: string }) => row.day)).toEqual([
      "2026-07-01",
      "2026-07-31",
    ]);
    expect(json.kpis.dailyActiveUsers).toBe(7);
    expect(json.daysLoaded).toBe(2);
  });
});

describe("overview route — active-user seat consistency", () => {
  it("does not count login casing variants as separate active users", async () => {
    const end = yesterday();
    const startDate = new Date(`${end}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 1);
    const start = startDate.toISOString().split("T")[0];

    db.prepare(`
      INSERT INTO copilot_seats (
        enterprise_slug, org_slug, user_login, user_id, plan_type,
        last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "ent1",
      "org1",
      "octocat",
      42,
      "business",
      `${end}T12:00:00Z`,
      "2026-01-01T00:00:00Z",
      `${end}T12:00:00Z`,
    );

    const insertMetric = db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMetric.run(start, "ent1", "ent1", 42, "OctoCat", 0, 0, 0, 0);
    insertMetric.run(end, "ent1", "ent1", 42, "octocat", 0, 0, 0, 0);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      `http://localhost/api/metrics/overview?startDate=${start}&endDate=${end}`,
    ));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.kpis.periodActiveUsers).toBe(1);
    expect(json.kpis.totalSeats).toBe(1);
    expect(json.kpis.activeUsersWithoutSeat).toBe(0);
    expect(json.kpis.licenseUtilization).toBe(100);
  });
});

describe("overview route — scoped billing KPI regression", () => {
  it("passes active team and org scope filters to getOverviewKPIs", async () => {
    const testDay = yesterday();
    mockGetOverviewKPIs.mockReturnValue({
      totalNet: 12,
      totalGross: 12,
      totalDiscount: 0,
      uniqueProducts: 1,
      uniqueOrgs: 1,
      userChargesNet: 12,
      orgChargesNet: 0,
    });

    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'platform', 'Platform', 'org', 'octo-org', 'alice', ?)
    `).run(`${testDay}T00:00:00Z`);
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "alice", 0, 0, 0, 0);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?days=1&teams=platform&orgs=octo-org&enterprises=ent1",
    ));

    expect(res.status).toBe(200);
    expect(mockGetOverviewKPIs).toHaveBeenCalledWith(
      testDay,
      testDay,
      {
        allowedLogins: ["alice"],
        allowedUserScopes: [{ enterpriseSlug: "ent1", userLogin: "alice" }],
        scopeOrgs: undefined,
      },
      ["ent1"],
    );
    const json = await res.json();
    expect(json.kpis.monthlyNetCost).toBe(360);
  });

  it("does not surface unfiltered AI credit totals when a scoped allowlist is empty", async () => {
    const testDay = yesterday();
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        ai_credits_used, used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "alice", 99, 0, 0, 0, 0);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?days=1&teams=no-members&enterprises=ent1",
    ));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.kpis.aiCreditsConsumed).toBeNull();
  });

  it("returns empty metrics when organization and team selections do not overlap", async () => {
    const testDay = yesterday();
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES
        ('ent1', 'platform', 'Platform', 'org', 'octo-org', 'alice', ?),
        ('ent1', 'security', 'Security', 'org', 'other-org', 'bob', ?)
    `).run(`${testDay}T00:00:00Z`, `${testDay}T00:00:00Z`);
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        ai_credits_used, used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "alice", 99, 1, 1, 0, 0);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?days=1&teams=security&orgs=octo-org&enterprises=ent1",
    ));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeUsersTrend).toEqual([]);
    expect(json.kpis.periodActiveUsers).toBe(0);
    expect(json.kpis.aiCreditsConsumed).toBeNull();
  });

  it("does not reuse an allowed login in a different enterprise", async () => {
    const testDay = yesterday();
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES
        ('ent1', 'platform', 'Platform', 'org', 'octodemo', 'alice', ?),
        ('ent2', 'security', 'Security', 'org', 'octodemo', 'bob', ?)
    `).run(`${testDay}T00:00:00Z`, `${testDay}T00:00:00Z`);
    const insertMetric = db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        ai_credits_used, used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMetric.run(testDay, "ent1", "ent1", 1, "alice", 0, 0, 0, 0, 0);
    insertMetric.run(testDay, "ent2", "ent2", 2, "bob", 0, 0, 0, 0, 0);
    insertMetric.run(testDay, "ent2", "ent2", 3, "alice", 99, 0, 0, 0, 0);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?days=1&teams=ent1:platform,ent2:security&orgs=octodemo",
    ));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeUsersTrend).toEqual([
      { day: testDay, daily: 2, weekly: 2, monthly: 2 },
    ]);
    expect(json.kpis.aiCreditsConsumed).toBeNull();
  });

  it("preserves enterprise identity for composite team-only filters", async () => {
    const testDay = yesterday();
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES
        ('ent1', 'platform', 'Platform', 'org', 'org1', 'alice', ?),
        ('ent2', 'security', 'Security', 'org', 'org2', 'bob', ?)
    `).run(`${testDay}T00:00:00Z`, `${testDay}T00:00:00Z`);
    const insertMetric = db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMetric.run(testDay, "ent1", "ent1", 1, "alice", 0, 0, 0, 0);
    insertMetric.run(testDay, "ent2", "ent2", 2, "bob", 0, 0, 0, 0);
    insertMetric.run(testDay, "ent2", "ent2", 3, "alice", 0, 0, 0, 0);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?days=1&teams=ent1:platform,ent2:security",
    ));
    const json = await res.json();

    expect(json.activeUsersTrend).toEqual([
      { day: testDay, daily: 2, weekly: 2, monthly: 2 },
    ]);
  });
});

describe("overview route — completion allowlist regression", { timeout: 10000 }, () => {
  it("enterprise-level branch: App/chat_inline/unknown rows do not alter acceptanceRateTrend[].rate", async () => {
    const { upsertEnterpriseDayMetrics } = await import("@/lib/db/metrics-repo");
    const testDay = yesterday();

    const totals_by_feature = [
      { feature: "code_completion", code_generation_activity_count: 50, code_acceptance_activity_count: 40, loc_added_sum: 80, loc_deleted_sum: 0, loc_suggested_to_add_sum: 100, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
      { feature: "inline_chat", code_generation_activity_count: 6, code_acceptance_activity_count: 4, loc_added_sum: 25, loc_deleted_sum: 0, loc_suggested_to_add_sum: 30, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
      { feature: "chat_panel_agent_mode", code_generation_activity_count: 3, code_acceptance_activity_count: 2, loc_added_sum: 15, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
      // These must NOT enter completion acceptance — deliberately huge to expose any leakage.
      { feature: "copilot_app", code_generation_activity_count: 500, code_acceptance_activity_count: 500, loc_added_sum: 60, loc_deleted_sum: 8, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
      { feature: "chat_inline", code_generation_activity_count: 1000, code_acceptance_activity_count: 1000, loc_added_sum: 1000, loc_deleted_sum: 0, loc_suggested_to_add_sum: 1000, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
      { feature: "some_future_unknown_feature", code_generation_activity_count: 2000, code_acceptance_activity_count: 2000, loc_added_sum: 2000, loc_deleted_sum: 0, loc_suggested_to_add_sum: 2000, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
      { feature: "agent_edit", code_generation_activity_count: 10, code_acceptance_activity_count: 0, loc_added_sum: 500, loc_deleted_sum: 200, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
    ];

    upsertEnterpriseDayMetrics("ent1", {
      day: testDay,
      enterprise_id: "ent1",
      daily_active_users: 10,
      weekly_active_users: 10,
      monthly_active_users: 10,
      monthly_active_agent_users: 1,
      monthly_active_chat_users: 1,
      daily_active_cli_users: 0,
      daily_active_copilot_app_users: null,
      code_generation_activity_count: 3569,
      code_acceptance_activity_count: 3546,
      user_initiated_interaction_count: 5,
      loc_suggested_to_add_sum: 3130,
      loc_suggested_to_delete_sum: 0,
      loc_added_sum: 3680,
      loc_deleted_sum: 208,
      totals_by_ide: [],
      totals_by_feature,
      totals_by_language_feature: [],
      totals_by_model_feature: [],
      totals_by_language_model: [],
    });

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("enterprise");
    const dayRow = json.acceptanceRateTrend.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    // codeGenCount = 50 + 6 + 3 = 59; codeAcceptCount = 40 + 4 + 2 = 46
    // rate = 46/59*100 = 77.966...% — NOT dominated by the much larger
    // copilot_app/chat_inline/unknown counts.
    expect(dayRow.rate).toBeCloseTo((46 / 59) * 100, 5);
    expect(dayRow.suggested).toBe(130); // 100 + 30 + 0 (chat_panel_agent_mode contributes 0)
    expect(dayRow.accepted).toBe(120); // 80 + 25 + 15
  });

  it("filtered/SQL-aggregated branch (getCompletionDailyTrend): App/chat_inline/unknown rows do not alter acceptanceRateTrend[].rate", async () => {
    const testDay = yesterday();

    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'platform', 'Platform', 'org', 'octo-org', 'octocat', ?)
    `).run(`${testDay}T00:00:00Z`);

    const totalsByFeature = JSON.stringify([
      { feature: "code_completion", loc_suggested_to_add_sum: 100, loc_added_sum: 80, code_generation_activity_count: 50, code_acceptance_activity_count: 40 },
      { feature: "inline_chat", loc_suggested_to_add_sum: 30, loc_added_sum: 25, code_generation_activity_count: 6, code_acceptance_activity_count: 4 },
      { feature: "chat_panel_agent_mode", loc_added_sum: 15, code_generation_activity_count: 3, code_acceptance_activity_count: 2 },
      { feature: "agent_edit", loc_added_sum: 500, code_generation_activity_count: 10, code_acceptance_activity_count: 0 },
      { feature: "copilot_app", loc_added_sum: 60, code_generation_activity_count: 500, code_acceptance_activity_count: 500 },
      { feature: "chat_inline", loc_added_sum: 1000, code_generation_activity_count: 1000, code_acceptance_activity_count: 1000 },
      { feature: "some_future_unknown_feature", loc_added_sum: 2000, code_generation_activity_count: 2000, code_acceptance_activity_count: 2000 },
    ]);

    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        code_generation_activity_count, code_acceptance_activity_count,
        loc_suggested_to_add_sum, loc_added_sum, loc_deleted_sum,
        user_initiated_interaction_count, used_agent, used_chat, used_cli,
        totals_by_feature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      testDay, "ent1", "ent1", 1, "octocat",
      3569, 3546,
      3130, 3680, 208,
      5, 1, 1, 0,
      totalsByFeature,
    );

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?days=1&teams=platform",
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("filtered-users");
    const dayRow = json.acceptanceRateTrend.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    // compGenCount = 50 + 6 + 3 = 59; compAcceptCount = 40 + 4 + 2 = 46
    expect(dayRow.rate).toBeCloseTo((46 / 59) * 100, 5);
    expect(dayRow.suggested).toBe(130);
    expect(dayRow.accepted).toBe(120);
  });
});

describe("overview route — Copilot App featureUsage.app", () => {
  it("filtered/SQL-aggregated branch: featureUsage[].app and kpis.copilotAppUsers reflect distinct used_copilot_app=1 users", async () => {
    const testDay = yesterday();

    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'platform', 'Platform', 'org', 'octo-org', 'octocat', ?)
    `).run(`${testDay}T00:00:00Z`);
    db.prepare(`
      INSERT INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
      VALUES ('ent1', 'platform', 'Platform', 'org', 'octo-org', 'hubot', ?)
    `).run(`${testDay}T00:00:00Z`);

    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "octocat", 0, 0, 0, 1);
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 2, "hubot", 0, 0, 0, 0);

    const GET = await getHandler();
    const res = await GET(new NextRequest(
      "http://localhost/api/metrics/overview?days=1&teams=platform",
    ));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("filtered-users");
    const dayRow = json.featureUsage.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    expect(dayRow.app).toBe(1);
    expect(json.kpis.copilotAppUsers).toBe(1);
  });

  it("aggregated-summary fallback (no direct enterprise_daily_metrics rows, no filter): featureUsage[].app uses the SQL-aggregated appUsers count", async () => {
    const testDay = yesterday();

    // No enterprise_daily_metrics row is inserted, so the enterprise-direct
    // branch has no data for this day and the route falls back to
    // getAggregatedDailySummary (grouped from user_daily_metrics) for the
    // day's metrics, including `app` via featureByDay.
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "octocat", 0, 0, 0, 1);

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    const dayRow = json.featureUsage.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    expect(dayRow.app).toBe(1);
    expect(json.kpis.copilotAppUsers).toBe(1);
  });

  it("enterprise-direct branch: an explicit daily_active_copilot_app_users=0 stays 0 even when the user-level fallback would be nonzero", async () => {
    const { upsertEnterpriseDayMetrics } = await import("@/lib/db/metrics-repo");
    const testDay = yesterday();

    // A nonzero user-level App signal exists for the same day/enterprise —
    // this MUST NOT override the enterprise row's own explicit, supported 0.
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "octocat", 0, 0, 0, 1);

    upsertEnterpriseDayMetrics("ent1", {
      day: testDay,
      enterprise_id: "ent1",
      daily_active_users: 10,
      weekly_active_users: 10,
      monthly_active_users: 10,
      monthly_active_agent_users: 1,
      monthly_active_chat_users: 1,
      daily_active_cli_users: 0,
      daily_active_copilot_app_users: 0,
      code_generation_activity_count: 100,
      code_acceptance_activity_count: 80,
      user_initiated_interaction_count: 5,
      loc_suggested_to_add_sum: 100,
      loc_suggested_to_delete_sum: 0,
      loc_added_sum: 100,
      loc_deleted_sum: 0,
      totals_by_ide: [],
      totals_by_feature: [],
      totals_by_language_feature: [],
      totals_by_model_feature: [],
      totals_by_language_model: [],
    });

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("enterprise");
    const dayRow = json.featureUsage.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    expect(dayRow.app).toBe(0);
    expect(json.kpis.copilotAppUsers).toBe(0);
  });

  it("enterprise-direct branch: a NULL daily_active_copilot_app_users (unavailable) falls back to the SQL-aggregated appUsers count", async () => {
    const { upsertEnterpriseDayMetrics } = await import("@/lib/db/metrics-repo");
    const testDay = yesterday();

    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "octocat", 0, 0, 0, 1);

    upsertEnterpriseDayMetrics("ent1", {
      day: testDay,
      enterprise_id: "ent1",
      daily_active_users: 10,
      weekly_active_users: 10,
      monthly_active_users: 10,
      monthly_active_agent_users: 1,
      monthly_active_chat_users: 1,
      daily_active_cli_users: 0,
      daily_active_copilot_app_users: null,
      code_generation_activity_count: 100,
      code_acceptance_activity_count: 80,
      user_initiated_interaction_count: 5,
      loc_suggested_to_add_sum: 100,
      loc_suggested_to_delete_sum: 0,
      loc_added_sum: 100,
      loc_deleted_sum: 0,
      totals_by_ide: [],
      totals_by_feature: [],
      totals_by_language_feature: [],
      totals_by_model_feature: [],
      totals_by_language_model: [],
    });

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("enterprise");
    const dayRow = json.featureUsage.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    expect(dayRow.app).toBe(1);
    expect(json.kpis.copilotAppUsers).toBe(1);
  });

  it("enterprise-direct branch: featureUsage[].chat and .agent are distinct used_chat=1/used_agent=1 user counts, not totals_by_feature event/interaction counts", async () => {
    const { upsertEnterpriseDayMetrics } = await import("@/lib/db/metrics-repo");
    const testDay = yesterday();

    // Two distinct users: one chat-active, one agent-active (neither both),
    // so the SQL-derived distinct-user counts (chatUsers=1, agentUsers=1)
    // are unambiguously different from the much larger totals_by_feature
    // event counts below.
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "alice", 0, 1, 0, 0);
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 2, "bob", 1, 0, 0, 0);

    const totals_by_feature = [
      // Deliberately large event/interaction counts to expose any leakage
      // into the distinct-user fields.
      { feature: "chat_panel", code_generation_activity_count: 0, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 900 },
      { feature: "agent_edit", code_generation_activity_count: 700, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
    ];

    upsertEnterpriseDayMetrics("ent1", {
      day: testDay,
      enterprise_id: "ent1",
      daily_active_users: 10,
      weekly_active_users: 10,
      monthly_active_users: 10,
      monthly_active_agent_users: 1,
      monthly_active_chat_users: 1,
      daily_active_cli_users: 0,
      daily_active_copilot_app_users: 0,
      code_generation_activity_count: 700,
      code_acceptance_activity_count: 80,
      user_initiated_interaction_count: 900,
      loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0,
      loc_deleted_sum: 0,
      totals_by_ide: [],
      totals_by_feature,
      totals_by_language_feature: [],
      totals_by_model_feature: [],
      totals_by_language_model: [],
    });

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("enterprise");
    const dayRow = json.featureUsage.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    expect(dayRow.chat).toBe(1);
    expect(dayRow.agent).toBe(1);
  });

  it("enterprise-direct branch: featureUsage[].chat and .agent fall back to legacy enterprise-direct values (never a false zero) when user_daily_metrics has no row for the day", async () => {
    const { upsertEnterpriseDayMetrics } = await import("@/lib/db/metrics-repo");
    const testDay = yesterday();

    // Deliberately no user_daily_metrics rows for this day — userMetrics is
    // disabled/empty in scope, so getFeatureUsageDaily's featureByDay map has
    // no entry for testDay. Without a fallback, chat/agent would silently
    // report 0 even though the enterprise row itself carries real evidence.
    const totals_by_feature = [
      { feature: "chat_panel", code_generation_activity_count: 0, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 42 },
      { feature: "agent_edit", code_generation_activity_count: 17, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
    ];

    upsertEnterpriseDayMetrics("ent1", {
      day: testDay,
      enterprise_id: "ent1",
      daily_active_users: 10,
      weekly_active_users: 10,
      monthly_active_users: 10,
      monthly_active_agent_users: 5,
      monthly_active_chat_users: 3,
      daily_active_cli_users: 0,
      daily_active_copilot_app_users: 0,
      code_generation_activity_count: 17,
      code_acceptance_activity_count: 0,
      user_initiated_interaction_count: 42,
      loc_suggested_to_add_sum: 0,
      loc_suggested_to_delete_sum: 0,
      loc_added_sum: 0,
      loc_deleted_sum: 0,
      totals_by_ide: [],
      totals_by_feature,
      totals_by_language_feature: [],
      totals_by_model_feature: [],
      totals_by_language_model: [],
    });

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("enterprise");
    const dayRow = json.featureUsage.find((t: { day: string }) => t.day === testDay);
    expect(dayRow).toBeDefined();
    // Legacy fallback: chat = totals_by_feature chat_panel* interaction count;
    // agent = totals_by_feature agent_edit code_generation_activity_count.
    expect(dayRow.chat).toBe(42);
    expect(dayRow.agent).toBe(17);
  });

  it("enterprise-direct branch: source decision is made ONCE per range — a day covered by user_daily_metrics never mixes with a day that legacy-falls-back, even within the same response", async () => {
    const { upsertEnterpriseDayMetrics } = await import("@/lib/db/metrics-repo");
    const testDay = yesterday();
    const prevDay = (() => {
      const d = new Date(testDay);
      d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })();

    // Only `testDay` has user_daily_metrics rows — `prevDay` has none, so
    // getFeatureUsageDaily returns exactly one row for the whole 2-day range.
    // Because at least one row exists in range, the covered day must use the
    // distinct-user count (1) and the uncovered day must report 0 — NOT the
    // uncovered day's legacy totals_by_feature values (42/17) — proving the
    // source decision is made once for the whole range, not per day.
    db.prepare(`
      INSERT INTO user_daily_metrics (
        day, enterprise_id, enterprise_slug, user_id, user_login,
        used_agent, used_chat, used_cli, used_copilot_app
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testDay, "ent1", "ent1", 1, "alice", 1, 1, 0, 0);

    const totals_by_feature = [
      { feature: "chat_panel", code_generation_activity_count: 0, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 42 },
      { feature: "agent_edit", code_generation_activity_count: 17, code_acceptance_activity_count: 0, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, user_initiated_interaction_count: 0 },
    ];

    for (const day of [prevDay, testDay]) {
      upsertEnterpriseDayMetrics("ent1", {
        day,
        enterprise_id: "ent1",
        daily_active_users: 10,
        weekly_active_users: 10,
        monthly_active_users: 10,
        monthly_active_agent_users: 5,
        monthly_active_chat_users: 3,
        daily_active_cli_users: 0,
        daily_active_copilot_app_users: 0,
        code_generation_activity_count: 17,
        code_acceptance_activity_count: 0,
        user_initiated_interaction_count: 42,
        loc_suggested_to_add_sum: 0,
        loc_suggested_to_delete_sum: 0,
        loc_added_sum: 0,
        loc_deleted_sum: 0,
        totals_by_ide: [],
        totals_by_feature,
        totals_by_language_feature: [],
        totals_by_model_feature: [],
        totals_by_language_model: [],
      });
    }

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=2"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("enterprise");
    const coveredRow = json.featureUsage.find((t: { day: string }) => t.day === testDay);
    const uncoveredRow = json.featureUsage.find((t: { day: string }) => t.day === prevDay);
    expect(coveredRow).toBeDefined();
    expect(uncoveredRow).toBeDefined();

    // Covered day: distinct-user counts from user_daily_metrics.
    expect(coveredRow.chat).toBe(1);
    expect(coveredRow.agent).toBe(1);

    // Uncovered day: 0, not the legacy 42/17 — since at least one row exists
    // in range, every day must use user-level counts (missing days become 0),
    // never mixing units within the same response.
    expect(uncoveredRow.chat).toBe(0);
    expect(uncoveredRow.agent).toBe(0);
  });
});
