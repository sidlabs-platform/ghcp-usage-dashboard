import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  getCopilotAppUserSummary,
  getCopilotAppDailyUsage,
  getCopilotAppDailyCodeImpact,
  getCopilotAppModelBreakdown,
  getCopilotAppLanguageBreakdown,
  estimateCopilotAppRowCount,
  getEnterpriseCopilotAppDaily,
  getOrganizationCopilotAppDaily,
  getCopilotAppAdopters,
} from "./copilot-app-queries";

const START = "2025-04-01";
const END = "2025-04-02";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));

  const insertUser = db.prepare(`
    INSERT INTO user_daily_metrics (
      day, enterprise_id, enterprise_slug, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count,
      user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum,
      loc_added_sum, loc_deleted_sum,
      used_agent, used_chat, used_cli,
      used_copilot_app,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model,
      totals_by_copilot_app
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ── Non-App feature/model/language entries shared by several users ──
  const nonAppFeature = (n: number) => ({
    feature: "code_completion",
    loc_added_sum: n,
    loc_deleted_sum: 0,
    loc_suggested_to_add_sum: n,
    loc_suggested_to_delete_sum: 0,
    code_generation_activity_count: 1,
    code_acceptance_activity_count: 1,
    user_initiated_interaction_count: 1,
  });
  const nonAppModel = { model: "gpt-4o", feature: "code_completion", user_initiated_interaction_count: 20 };
  const nonAppLanguage = {
    language: "typescript",
    feature: "code_completion",
    loc_added_sum: 5,
    loc_deleted_sum: 0,
    loc_suggested_to_add_sum: 5,
    loc_suggested_to_delete_sum: 0,
    code_generation_activity_count: 1,
    code_acceptance_activity_count: 1,
  };

  // ── alice: App user, active on two days, duplicated across two ──
  // enterprises (acme, beta) on day 1 with identical App metrics.
  const aliceAppFeatureDay1 = {
    feature: "copilot_app",
    loc_added_sum: 40,
    loc_deleted_sum: 10,
    loc_suggested_to_add_sum: 0,
    loc_suggested_to_delete_sum: 0,
    code_generation_activity_count: 8,
    code_acceptance_activity_count: 5,
    user_initiated_interaction_count: 9,
  };
  const aliceAppFeatureDay2 = {
    feature: "copilot_app",
    loc_added_sum: 30,
    loc_deleted_sum: 5,
    loc_suggested_to_add_sum: 0,
    loc_suggested_to_delete_sum: 0,
    code_generation_activity_count: 6,
    code_acceptance_activity_count: 4,
    user_initiated_interaction_count: 7,
  };
  const aliceAppModelDay1 = { model: "gpt-5", feature: "copilot_app", user_initiated_interaction_count: 9 };
  const aliceAppModelDay2 = { model: "gpt-5", feature: "copilot_app", user_initiated_interaction_count: 7 };
  const aliceAppLanguageDay1 = {
    language: "python",
    feature: "copilot_app",
    loc_added_sum: 40,
    loc_deleted_sum: 10,
    loc_suggested_to_add_sum: 0,
    loc_suggested_to_delete_sum: 0,
    code_generation_activity_count: 8,
    code_acceptance_activity_count: 5,
  };
  const aliceAppLanguageDay2 = {
    language: "python",
    feature: "copilot_app",
    loc_added_sum: 30,
    loc_deleted_sum: 5,
    loc_suggested_to_add_sum: 0,
    loc_suggested_to_delete_sum: 0,
    code_generation_activity_count: 6,
    code_acceptance_activity_count: 4,
  };
  const aliceTotalsAppDay1 = JSON.stringify({
    session_count: 2,
    request_count: 5,
    prompt_count: 4,
    token_usage: { prompt_tokens_sum: 1000, output_tokens_sum: 1000, avg_tokens_per_request: 250 },
  });
  const aliceTotalsAppDay2 = JSON.stringify({
    session_count: 3,
    request_count: 5,
    prompt_count: 2,
    token_usage: { prompt_tokens_sum: 800, output_tokens_sum: 200, avg_tokens_per_request: 500 },
  });
  const aliceFeatureDay1 = JSON.stringify([nonAppFeature(5), aliceAppFeatureDay1]);
  const aliceFeatureDay2 = JSON.stringify([nonAppFeature(3), aliceAppFeatureDay2]);
  const aliceModelDay1 = JSON.stringify([nonAppModel, aliceAppModelDay1]);
  const aliceModelDay2 = JSON.stringify([nonAppModel, aliceAppModelDay2]);
  const aliceLanguageDay1 = JSON.stringify([nonAppLanguage, aliceAppLanguageDay1]);
  const aliceLanguageDay2 = JSON.stringify([nonAppLanguage, aliceAppLanguageDay2]);

  // alice / day 1 / enterprise acme
  insertUser.run(
    "2025-04-01", "ent1", "acme", 1, "alice",
    8, 5, 9, 0, 0, 40, 10, 0, 0, 0, 1,
    "[]", aliceFeatureDay1, aliceLanguageDay1, aliceModelDay1, "[]",
    aliceTotalsAppDay1,
  );
  // alice / day 1 / enterprise beta — duplicate of the same user/day across
  // enterprises, with identical App metrics (must be deduplicated by MAX).
  insertUser.run(
    "2025-04-01", "ent2", "beta", 1, "alice",
    8, 5, 9, 0, 0, 40, 10, 0, 0, 0, 1,
    "[]", aliceFeatureDay1, aliceLanguageDay1, aliceModelDay1, "[]",
    aliceTotalsAppDay1,
  );
  // alice / day 2 / enterprise acme only
  insertUser.run(
    "2025-04-02", "ent1", "acme", 1, "alice",
    6, 4, 7, 0, 0, 30, 5, 0, 0, 0, 1,
    "[]", aliceFeatureDay2, aliceLanguageDay2, aliceModelDay2, "[]",
    aliceTotalsAppDay2,
  );

  // ── bob: supported, explicit used_copilot_app=0, all-zero App totals ──
  insertUser.run(
    "2025-04-01", "ent1", "acme", 2, "bob",
    1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0,
    "[]", JSON.stringify([nonAppFeature(1)]), JSON.stringify([nonAppLanguage]), JSON.stringify([nonAppModel]), "[]",
    JSON.stringify({
      session_count: 0,
      request_count: 0,
      prompt_count: 0,
      token_usage: { prompt_tokens_sum: 0, output_tokens_sum: 0, avg_tokens_per_request: 0 },
    }),
  );

  // ── carol: legacy, no App columns at all (pre-App-tracking data) ──
  insertUser.run(
    "2025-04-01", "ent1", "acme", 3, "carol",
    1, 1, 1, 1, 0, 1, 0, 0, 0, 0, null,
    "[]", JSON.stringify([nonAppFeature(1)]), JSON.stringify([nonAppLanguage]), JSON.stringify([nonAppModel]), "[]",
    null,
  );

  // ── erin: App adopter via dedicated totals only (no App feature row) ──
  insertUser.run(
    "2025-04-01", "ent1", "acme", 4, "erin",
    1, 1, 1, 1, 0, 1, 0, 0, 0, 0, null,
    "[]", JSON.stringify([nonAppFeature(1)]), JSON.stringify([nonAppLanguage]),
    JSON.stringify([nonAppModel, { model: "claude-3", feature: "copilot_app", user_initiated_interaction_count: 4 }]),
    "[]",
    JSON.stringify({
      session_count: 1,
      request_count: 2,
      prompt_count: 1,
      token_usage: { prompt_tokens_sum: 300, output_tokens_sum: 100, avg_tokens_per_request: 200 },
    }),
  );

  // ── frank: App adopter via App feature row only (no dedicated totals) ──
  insertUser.run(
    "2025-04-01", "ent1", "acme", 5, "frank",
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null,
    "[]",
    JSON.stringify([
      nonAppFeature(1),
      {
        feature: "copilot_app",
        loc_added_sum: 12,
        loc_deleted_sum: 3,
        loc_suggested_to_add_sum: 0,
        loc_suggested_to_delete_sum: 0,
        code_generation_activity_count: 4,
        code_acceptance_activity_count: 2,
        user_initiated_interaction_count: 5,
      },
    ]),
    JSON.stringify([
      nonAppLanguage,
      {
        language: "go",
        feature: "copilot_app",
        loc_added_sum: 12,
        loc_deleted_sum: 3,
        loc_suggested_to_add_sum: 0,
        loc_suggested_to_delete_sum: 0,
        code_generation_activity_count: 4,
        code_acceptance_activity_count: 2,
      },
    ]),
    JSON.stringify([nonAppModel]),
    "[]",
    null,
  );

  // ── dave: explicit used_copilot_app=false, no dedicated totals, no App
  // feature row — must be excluded from the adopters list. Distinct from
  // bob, whose non-null (all-zero) totals_by_copilot_app object *does*
  // count as App telemetry. Placed on 2025-04-03, outside the shared
  // START/END window, so it does not affect other describe blocks above.
  insertUser.run(
    "2025-04-03", "ent1", "acme", 6, "dave",
    1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0,
    "[]", JSON.stringify([nonAppFeature(1)]), JSON.stringify([nonAppLanguage]), JSON.stringify([nonAppModel]), "[]",
    null,
  );

  // ── grace: duplicated across acme/beta on the same day with DIFFERING
  // (not identical) dedicated-totals values, placed on its own day
  // (2025-04-05) so it doesn't perturb the shared START/END fixtures.
  // This pins the MAX-before-SUM dedup policy unambiguously: a bug that
  // summed duplicates, averaged them, or took the first/last row would
  // all disagree with plain MAX(9, 2) = 9.
  const graceTotalsAcme = JSON.stringify({
    session_count: 9, request_count: 6, prompt_count: 3,
    token_usage: { prompt_tokens_sum: 900, output_tokens_sum: 300, avg_tokens_per_request: 300 },
  });
  const graceTotalsBeta = JSON.stringify({
    session_count: 2, request_count: 1, prompt_count: 1,
    token_usage: { prompt_tokens_sum: 200, output_tokens_sum: 50, avg_tokens_per_request: 200 },
  });
  const graceFeatureAcme = JSON.stringify([
    { feature: "copilot_app", loc_added_sum: 70, loc_deleted_sum: 8, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, code_generation_activity_count: 9, code_acceptance_activity_count: 6, user_initiated_interaction_count: 9 },
  ]);
  const graceFeatureBeta = JSON.stringify([
    { feature: "copilot_app", loc_added_sum: 4, loc_deleted_sum: 1, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, code_generation_activity_count: 2, code_acceptance_activity_count: 1, user_initiated_interaction_count: 2 },
  ]);
  insertUser.run(
    "2025-04-05", "ent1", "acme", 7, "grace",
    9, 6, 9, 0, 0, 70, 8, 0, 0, 0, 1,
    "[]", graceFeatureAcme, "[]", "[]", "[]",
    graceTotalsAcme,
  );
  insertUser.run(
    "2025-04-05", "ent2", "beta", 7, "grace",
    2, 1, 2, 0, 0, 4, 1, 0, 0, 0, 1,
    "[]", graceFeatureBeta, "[]", "[]", "[]",
    graceTotalsBeta,
  );

  // ── hank: malformed copilot_app model/language feature entries missing
  // their `model`/`language` key entirely — must never surface as a
  // breakdown row with a null `name`. Placed on 2025-04-06, its own
  // isolated day, alongside ivy's well-formed entries so the breakdown
  // functions are proven to keep good rows while dropping bad ones.
  insertUser.run(
    "2025-04-06", "ent1", "acme", 8, "hank",
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null,
    "[]", "[]",
    JSON.stringify([{ feature: "copilot_app", code_generation_activity_count: 2, loc_added_sum: 9, loc_deleted_sum: 1 }]), // no `language`
    JSON.stringify([{ feature: "copilot_app", user_initiated_interaction_count: 5 }]), // no `model`
    "[]",
    null,
  );
  insertUser.run(
    "2025-04-06", "ent1", "acme", 9, "ivy",
    4, 2, 4, 0, 0, 20, 2, 0, 0, 0, 1,
    "[]", "[]",
    JSON.stringify([{ language: "rust", feature: "copilot_app", code_generation_activity_count: 4, loc_added_sum: 20, loc_deleted_sum: 2 }]),
    JSON.stringify([{ model: "grok-2", feature: "copilot_app", user_initiated_interaction_count: 11 }]),
    "[]",
    JSON.stringify({
      session_count: 3, request_count: 4, prompt_count: 2,
      token_usage: { prompt_tokens_sum: 100, output_tokens_sum: 50, avg_tokens_per_request: 75 },
    }),
  );

  // ── Bulk synthetic adopters for pagination-clamp tests, isolated on
  // their own day (2025-05-01) so they never leak into the shared
  // START/END assertions above. 205 rows so a pageSize clamp to 200 is
  // actually observable (vs. requesting more rows than exist).
  const insertBulk = db.prepare(`
    INSERT INTO user_daily_metrics (
      day, enterprise_id, enterprise_slug, user_id, user_login,
      used_copilot_app, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_copilot_app
    ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', NULL)
  `);
  const insertBulkTx = db.transaction(() => {
    for (let i = 1; i <= 205; i++) {
      const login = `bulk_user_${String(i).padStart(3, "0")}`;
      insertBulk.run("2025-05-01", "ent1", "acme", 1000 + i, login, 1);
    }
  });
  insertBulkTx();

  // ── Enterprise aggregate rows ──
  const insertEnterprise = db.prepare(`
    INSERT INTO enterprise_daily_metrics (
      day, enterprise_id, enterprise_slug, daily_active_users,
      daily_active_copilot_app_users, totals_by_feature, totals_by_copilot_app
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const entAppFeature = (gen: number, acc: number, add: number, del: number) =>
    JSON.stringify([
      nonAppFeature(1),
      {
        feature: "copilot_app",
        loc_added_sum: add,
        loc_deleted_sum: del,
        loc_suggested_to_add_sum: 0,
        loc_suggested_to_delete_sum: 0,
        code_generation_activity_count: gen,
        code_acceptance_activity_count: acc,
        user_initiated_interaction_count: gen + acc,
      },
    ]);
  // acme, day1: supported, real activity
  insertEnterprise.run(
    "2025-04-01", "ent1", "acme", 50, 5,
    entAppFeature(80, 50, 400, 100),
    JSON.stringify({
      session_count: 20, request_count: 60, prompt_count: 40,
      token_usage: { prompt_tokens_sum: 5000, output_tokens_sum: 3000, avg_tokens_per_request: 125 },
    }),
  );
  // beta, day1: supported, real activity (separate enterprise, same day)
  insertEnterprise.run(
    "2025-04-01", "ent2", "beta", 30, 3,
    entAppFeature(20, 10, 80, 20),
    JSON.stringify({
      session_count: 10, request_count: 20, prompt_count: 15,
      token_usage: { prompt_tokens_sum: 1000, output_tokens_sum: 500, avg_tokens_per_request: 50 },
    }),
  );
  // gamma, day1: legacy/unsupported (no App columns) — same day as acme/beta
  insertEnterprise.run("2025-04-01", "ent3", "gamma", 40, null, JSON.stringify([nonAppFeature(1)]), null);
  // acme, day2: supported, zero activity (no App feature row that day)
  insertEnterprise.run(
    "2025-04-02", "ent1", "acme", 45, 0,
    JSON.stringify([nonAppFeature(1)]),
    JSON.stringify({
      session_count: 0, request_count: 0, prompt_count: 0,
      token_usage: { prompt_tokens_sum: 0, output_tokens_sum: 0, avg_tokens_per_request: 0 },
    }),
  );

  // ── Organization aggregate rows ──
  const insertOrg = db.prepare(`
    INSERT INTO org_daily_metrics (
      day, org_slug, enterprise_slug, daily_active_users,
      daily_active_copilot_app_users, totals_by_feature, totals_by_copilot_app
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertOrg.run(
    "2025-04-01", "contoso-org", "acme", 20, 2,
    entAppFeature(16, 9, 64, 16),
    JSON.stringify({
      session_count: 8, request_count: 16, prompt_count: 10,
      token_usage: { prompt_tokens_sum: 400, output_tokens_sum: 200, avg_tokens_per_request: 60 },
    }),
  );
  insertOrg.run("2025-04-02", "contoso-org", "acme", 18, null, JSON.stringify([nonAppFeature(1)]), null);
});

afterAll(() => {
  db.close();
});

describe("getCopilotAppUserSummary", () => {
  it("computes period KPIs with weighted token average, active-user denominator/numerator, and dedup", () => {
    const result = getCopilotAppUserSummary(START, END);
    expect(result.periodActiveUsers).toBe(5); // alice, bob, carol, erin, frank
    expect(result.appActiveUsers).toBe(3); // alice, erin, frank (bob is zero-activity, carol has no data)
    expect(result.adoptionRate).toBeCloseTo((3 / 5) * 100, 5);
    expect(result.sessions).toBe(6); // alice 2+3, erin 1
    expect(result.requests).toBe(12); // alice 5+5, erin 2
    expect(result.prompts).toBe(7); // alice 4+2, erin 1
    expect(result.promptTokens).toBe(2100); // alice 1000+800, erin 300
    expect(result.outputTokens).toBe(1300); // alice 1000+200, erin 100
    // weighted avg = (promptTokens+outputTokens)/requests, never avg of daily averages
    const expectedAvg = Math.round(((2100 + 1300) / 12) * 10) / 10;
    expect(result.avgTokensPerRequest).toBeCloseTo(expectedAvg, 5);
    expect(result.codeGenerations).toBe(18); // alice 8+6, frank 4
    expect(result.codeAcceptances).toBe(11); // alice 5+4, frank 2
    expect(result.locAdded).toBe(82); // alice 40+30, frank 12
    expect(result.locDeleted).toBe(18); // alice 10+5, frank 3
    expect(result.locChanged).toBe(100);
  });

  it("counts supported rows (non-null flag, non-null totals, or App feature row) but not legacy absence", () => {
    const result = getCopilotAppUserSummary(START, END);
    // alice x3 rows (2 enterprises day1 + day2) + bob(1) + erin(1) + frank(1) = 6; carol excluded
    expect(result.supportedRows).toBe(6);
  });

  it("returns zero KPIs when allowedLogins is explicitly empty, and full KPIs when undefined", () => {
    const empty = getCopilotAppUserSummary(START, END, []);
    expect(empty.periodActiveUsers).toBe(0);
    expect(empty.appActiveUsers).toBe(0);
    expect(empty.sessions).toBe(0);
    expect(empty.supportedRows).toBe(0);

    const unfiltered = getCopilotAppUserSummary(START, END, undefined);
    expect(unfiltered.periodActiveUsers).toBe(5);
  });

  it("scopes to allowedLogins when provided as a non-empty array", () => {
    const result = getCopilotAppUserSummary(START, END, ["alice", "bob"]);
    expect(result.periodActiveUsers).toBe(2);
    expect(result.appActiveUsers).toBe(1); // alice only
    expect(result.sessions).toBe(5); // alice only (bob is zero)
  });

  it("scopes to enterpriseSlugs when provided, changing supportedRows relative to unfiltered", () => {
    // alice's beta-duplicate row should not double her totals even when
    // scoping to a single enterprise.
    const result = getCopilotAppUserSummary(START, END, undefined, ["acme"]);
    expect(result.sessions).toBe(6);
    // Unfiltered supportedRows is 6 (alice's acme+beta day1 rows + her acme
    // day2 row + bob + erin + frank). Scoping to acme alone drops alice's
    // beta row, so supportedRows must visibly change to 5 — proving the
    // enterprise filter is actually applied to the supported-row count,
    // not just to the summed totals.
    expect(result.supportedRows).toBe(5);
    const unfiltered = getCopilotAppUserSummary(START, END);
    expect(unfiltered.supportedRows).toBe(6);
    expect(result.supportedRows).not.toBe(unfiltered.supportedRows);
  });

  it("dedups a user duplicated across enterprises with DIFFERING values via MAX, never SUM/average", () => {
    // grace: acme reports session_count=9, beta reports session_count=2 for
    // the same user/day. A correct MAX-before-SUM dedup yields 9. A bug that
    // summed the duplicates would yield 11; one that averaged them would
    // yield 5.5; one that picked an arbitrary row could yield either 9 or 2
    // nondeterministically. Only 9 is consistent with MAX every time.
    const result = getCopilotAppUserSummary("2025-04-05", "2025-04-05", ["grace"]);
    expect(result.sessions).toBe(9);
    expect(result.requests).toBe(6);
    expect(result.prompts).toBe(3);
    expect(result.promptTokens).toBe(900);
    expect(result.outputTokens).toBe(300);
    expect(result.codeGenerations).toBe(9);
    expect(result.codeAcceptances).toBe(6);
    expect(result.locAdded).toBe(70);
    expect(result.locDeleted).toBe(8);
  });
});

describe("getCopilotAppDailyUsage", () => {
  it("returns the adoption trend sorted by day ascending, deduplicated across enterprises", () => {
    const trend = getCopilotAppDailyUsage(START, END);
    expect(trend.map((r) => r.day)).toEqual(["2025-04-01", "2025-04-02"]);

    const day1 = trend[0];
    // active on day1: alice, erin, frank => 3
    expect(day1.activeUsers).toBe(3);
    expect(day1.sessions).toBe(3); // alice 2 (deduped across acme/beta) + erin 1
    expect(day1.requests).toBe(7); // alice 5 + erin 2
    expect(day1.prompts).toBe(5); // alice 4 + erin 1

    const day2 = trend[1];
    expect(day2.activeUsers).toBe(1); // alice only
    expect(day2.sessions).toBe(3);
    expect(day2.requests).toBe(5);
    expect(day2.prompts).toBe(2);
  });

  it("returns an empty trend for an explicitly empty allowedLogins array", () => {
    expect(getCopilotAppDailyUsage(START, END, [])).toEqual([]);
  });
});

describe("getCopilotAppDailyCodeImpact", () => {
  it("returns the code-impact trend sorted by day ascending, from App feature rows only", () => {
    const trend = getCopilotAppDailyCodeImpact(START, END);
    expect(trend.map((r) => r.day)).toEqual(["2025-04-01", "2025-04-02"]);

    const day1 = trend[0];
    // alice (8 gen / 5 acc / 40 added / 10 deleted, deduped) + frank (4/2/12/3)
    expect(day1.generations).toBe(12);
    expect(day1.acceptances).toBe(7);
    expect(day1.locAdded).toBe(52);
    expect(day1.locDeleted).toBe(13);

    const day2 = trend[1];
    expect(day2.generations).toBe(6);
    expect(day2.acceptances).toBe(4);
    expect(day2.locAdded).toBe(30);
    expect(day2.locDeleted).toBe(5);
  });

  it("returns an empty trend for an explicitly empty allowedLogins array", () => {
    expect(getCopilotAppDailyCodeImpact(START, END, [])).toEqual([]);
  });
});

describe("getCopilotAppModelBreakdown", () => {
  it("filters to feature='copilot_app' only and sorts by interactions descending", () => {
    const rows = getCopilotAppModelBreakdown(START, END);
    expect(rows).toEqual([
      { name: "gpt-5", interactions: 16 }, // alice 9 (deduped) + 7
      { name: "claude-3", interactions: 4 }, // erin
    ]);
    // gpt-4o (non-App) must never appear
    expect(rows.find((r) => r.name === "gpt-4o")).toBeUndefined();
  });

  it("returns an empty breakdown for an explicitly empty allowedLogins array", () => {
    expect(getCopilotAppModelBreakdown(START, END, [])).toEqual([]);
  });

  it("excludes copilot_app model-feature entries with a null/missing model name", () => {
    // hank's copilot_app model entry has no `model` key at all (json_extract
    // returns NULL); it must never surface as a row with name === null, and
    // ivy's well-formed "grok-2" entry must still come through untouched.
    const rows = getCopilotAppModelBreakdown("2025-04-06", "2025-04-06");
    expect(rows).toEqual([{ name: "grok-2", interactions: 11 }]);
    expect(rows.every((r) => typeof r.name === "string")).toBe(true);
  });
});

describe("getCopilotAppLanguageBreakdown", () => {
  it("filters to feature='copilot_app', uses summed code_generation_activity_count as interactions, sorts by locAdded descending", () => {
    const rows = getCopilotAppLanguageBreakdown(START, END);
    expect(rows).toEqual([
      { name: "python", interactions: 14, locAdded: 70, locDeleted: 15 }, // alice deduped+summed
      { name: "go", interactions: 4, locAdded: 12, locDeleted: 3 }, // frank
    ]);
    expect(rows.find((r) => r.name === "typescript")).toBeUndefined();
  });

  it("returns an empty breakdown for an explicitly empty allowedLogins array", () => {
    expect(getCopilotAppLanguageBreakdown(START, END, [])).toEqual([]);
  });

  it("excludes copilot_app language-feature entries with a null/missing language name", () => {
    // hank's copilot_app language entry has no `language` key at all; it
    // must never surface as a row with name === null, while ivy's
    // well-formed "rust" entry still comes through untouched.
    const rows = getCopilotAppLanguageBreakdown("2025-04-06", "2025-04-06");
    expect(rows).toEqual([{ name: "rust", interactions: 4, locAdded: 20, locDeleted: 2 }]);
    expect(rows.every((r) => typeof r.name === "string")).toBe(true);
  });
});

describe("estimateCopilotAppRowCount", () => {
  it("counts rows in scope and applies the App-aware empty-login semantics", () => {
    const unfiltered = estimateCopilotAppRowCount(START, END);
    expect(unfiltered.count).toBe(7); // alice x3 + bob + carol + erin + frank
    expect(unfiltered.exceeds).toBe(false);

    const empty = estimateCopilotAppRowCount(START, END, []);
    expect(empty.count).toBe(0);
    expect(empty.exceeds).toBe(false);

    const scoped = estimateCopilotAppRowCount(START, END, ["alice"]);
    expect(scoped.count).toBe(3);
  });

  it("marks exceeds=true only once the row count is strictly greater than the 500,000 threshold", () => {
    // Exercising the real 500,001-row boundary would mean physically
    // inserting half a million rows into the in-memory database just to
    // read back a COUNT(*). Instead, stub `db.prepare` for this one test
    // so the query layer's own arithmetic (`row.cnt > 500_000`) runs
    // against a controlled `cnt`, without altering production semantics.
    const prepareSpy = vi.spyOn(db, "prepare").mockReturnValue({
      get: () => ({ cnt: 500_001 }),
    } as unknown as ReturnType<typeof db.prepare>);

    try {
      const result = estimateCopilotAppRowCount(START, END);
      expect(result.count).toBe(500_001);
      expect(result.exceeds).toBe(true);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("getEnterpriseCopilotAppDaily", () => {
  it("returns supported rows (including zero-activity days) and excludes unsupported legacy rows", () => {
    const rows = getEnterpriseCopilotAppDaily(START, END, ["acme"]);
    expect(rows.map((r) => r.day)).toEqual(["2025-04-01", "2025-04-02"]);

    const day1 = rows[0];
    expect(day1.isSupported).toBe(true);
    expect(day1.sourceActiveUsers).toBe(50);
    expect(day1.activeUsers).toBe(5);
    expect(day1.sessions).toBe(20);
    expect(day1.requests).toBe(60);
    expect(day1.prompts).toBe(40);
    expect(day1.promptTokens).toBe(5000);
    expect(day1.outputTokens).toBe(3000);
    expect(day1.generations).toBe(80);
    expect(day1.acceptances).toBe(50);
    expect(day1.locAdded).toBe(400);
    expect(day1.locDeleted).toBe(100);

    const day2 = rows[1];
    expect(day2.isSupported).toBe(true);
    expect(day2.sessions).toBe(0);
    expect(day2.activeUsers).toBe(0);
    expect(day2.generations).toBe(0);
  });

  it("aggregates safely across multiple enterprises on the same day without cross-multiplying JSON arrays", () => {
    const rows = getEnterpriseCopilotAppDaily(START, END, ["acme", "beta"]);
    const day1 = rows.find((r) => r.day === "2025-04-01")!;
    expect(day1.sourceActiveUsers).toBe(80); // 50 + 30
    expect(day1.activeUsers).toBe(8); // 5 + 3
    expect(day1.sessions).toBe(30); // 20 + 10
    expect(day1.generations).toBe(100); // 80 + 20
    expect(day1.locAdded).toBe(480); // 400 + 80
  });

  it("excludes an unsupported (legacy) enterprise entirely when scoped alone", () => {
    const rows = getEnterpriseCopilotAppDaily(START, END, ["gamma"]);
    expect(rows).toEqual([]);
  });

  it("excludes an unsupported enterprise's daily_active_users from sourceActiveUsers when mixed with supported enterprises on the same day", () => {
    // gamma (unsupported, daily_active_users=40) shares 2025-04-01 with
    // acme (50) and beta (30), both supported. A denominator bug that
    // summed daily_active_users across ALL rows for the day (rather than
    // only rows with App support evidence) would report 120 instead of 80.
    const rows = getEnterpriseCopilotAppDaily(START, END, ["acme", "beta", "gamma"]);
    const day1 = rows.find((r) => r.day === "2025-04-01")!;
    expect(day1.sourceActiveUsers).toBe(80); // 50 (acme) + 30 (beta); gamma's 40 excluded
    expect(day1.isSupported).toBe(true);
    // activeUsers (the numerator) is unaffected either way since gamma's
    // daily_active_copilot_app_users is NULL and SUM() already ignores NULLs.
    expect(day1.activeUsers).toBe(8);
  });

  it("queries only the fixed enterprise_daily_metrics table, never org_daily_metrics", () => {
    // Behavioral replacement for a brittle function-arity check: capture the
    // actual SQL text the function prepares and assert it reads from its one
    // intended source table.
    const prepareSpy = vi.spyOn(db, "prepare");
    try {
      getEnterpriseCopilotAppDaily(START, END, ["acme"]);
      const sqlText = prepareSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(sqlText).toContain("FROM enterprise_daily_metrics");
      expect(sqlText).not.toContain("org_daily_metrics");
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("getOrganizationCopilotAppDaily", () => {
  it("returns supported org rows and excludes unsupported ones", () => {
    const rows = getOrganizationCopilotAppDaily("contoso-org", START, END);
    expect(rows.map((r) => r.day)).toEqual(["2025-04-01"]);
    const day1 = rows[0];
    expect(day1.isSupported).toBe(true);
    expect(day1.sourceActiveUsers).toBe(20);
    expect(day1.activeUsers).toBe(2);
    expect(day1.sessions).toBe(8);
    expect(day1.generations).toBe(16);
    expect(day1.locAdded).toBe(64);
  });

  it("filters by enterpriseSlugs when provided", () => {
    const rows = getOrganizationCopilotAppDaily("contoso-org", START, END, ["gamma"]);
    expect(rows).toEqual([]);
  });

  it("queries only the fixed org_daily_metrics table, never enterprise_daily_metrics", () => {
    const prepareSpy = vi.spyOn(db, "prepare");
    try {
      getOrganizationCopilotAppDaily("contoso-org", START, END);
      const sqlText = prepareSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(sqlText).toContain("FROM org_daily_metrics");
      expect(sqlText).not.toContain("enterprise_daily_metrics");
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("getCopilotAppAdopters", () => {
  it("includes logins via true used_copilot_app flag, positive dedicated totals, or a positive App feature row; excludes zero-activity/legacy rows", () => {
    // bob has used_copilot_app=false and a non-null totals_by_copilot_app
    // object, but every counter in it is zero — that's schema *support*,
    // not actual *activity*, so per the adopters/active-KPI alignment he
    // must be excluded from the adopter table (unlike the old
    // evidence-only semantics that used to include him).
    const { adopters, total } = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc");
    const logins = adopters.map((a) => a.login).sort();
    expect(logins).toEqual(["alice", "erin", "frank"]);
    expect(logins).not.toContain("bob");
    expect(total).toBe(3);
  });

  it("has no zero-only adopter row: every adopter has activeDays >= 1 and at least one positive activity metric", () => {
    const { adopters } = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc");
    for (const adopter of adopters) {
      expect(adopter.activeDays).toBeGreaterThanOrEqual(1);
      const hasPositiveActivity =
        adopter.sessions > 0 ||
        adopter.requests > 0 ||
        adopter.prompts > 0 ||
        adopter.locAdded > 0 ||
        adopter.locDeleted > 0;
      expect(hasPositiveActivity).toBe(true);
    }
  });

  it("adopter total equals the distinct active-user KPI (appActiveUsers) for the same scope", () => {
    const { total } = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc");
    const kpi = getCopilotAppUserSummary(START, END);
    expect(total).toBe(kpi.appActiveUsers);
  });

  it("deduplicates the same login/day across enterprises before summing period totals", () => {
    const { adopters } = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc");
    const alice = adopters.find((a) => a.login === "alice")!;
    expect(alice.activeDays).toBe(2);
    expect(alice.sessions).toBe(5); // 2 (deduped) + 3
    expect(alice.requests).toBe(10);
    expect(alice.prompts).toBe(6);
    expect(alice.promptTokens).toBe(1800);
    expect(alice.outputTokens).toBe(1200);
    expect(alice.locAdded).toBe(70);
    expect(alice.locDeleted).toBe(15);
  });

  it("supports search on login (parameterized)", () => {
    const { adopters, total } = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc", "ali");
    expect(adopters.map((a) => a.login)).toEqual(["alice"]);
    expect(total).toBe(1);
  });

  it("escapes literal %, _, and backslash in the search text instead of treating them as SQL LIKE wildcards", () => {
    // None of the fixture logins contain literal '%' or '_' characters. An
    // unescaped LIKE '%<search>%' would treat '%' as "match anything" and
    // '_' as "match any one character" — so searching for these literal
    // characters would incorrectly match every/some login if the escape
    // clause were missing or broken.
    const percent = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc", "%");
    expect(percent.adopters).toEqual([]);
    expect(percent.total).toBe(0);

    const underscore = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc", "_");
    expect(underscore.adopters).toEqual([]);
    expect(underscore.total).toBe(0);

    const backslash = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc", "\\");
    expect(backslash.adopters).toEqual([]);
    expect(backslash.total).toBe(0);
  });

  it("sorts by every allowlisted field", () => {
    const byLogin = getCopilotAppAdopters(START, END, 1, 10, "login", "asc").adopters.map((a) => a.login);
    expect(byLogin).toEqual(["alice", "erin", "frank"]);

    const byActiveDays = getCopilotAppAdopters(START, END, 1, 10, "activeDays", "desc").adopters.map((a) => a.login);
    expect(byActiveDays[0]).toBe("alice");

    const byLocAdded = getCopilotAppAdopters(START, END, 1, 10, "locAdded", "desc").adopters.map((a) => a.login);
    expect(byLocAdded[0]).toBe("alice");
    expect(byLocAdded[1]).toBe("frank");

    const byLocDeleted = getCopilotAppAdopters(START, END, 1, 10, "locDeleted", "desc").adopters.map((a) => a.login);
    expect(byLocDeleted[0]).toBe("alice");

    const byRequests = getCopilotAppAdopters(START, END, 1, 10, "requests", "desc").adopters.map((a) => a.login);
    expect(byRequests[0]).toBe("alice");

    const byPrompts = getCopilotAppAdopters(START, END, 1, 10, "prompts", "desc").adopters.map((a) => a.login);
    expect(byPrompts[0]).toBe("alice");

    const byPromptTokens = getCopilotAppAdopters(START, END, 1, 10, "promptTokens", "desc").adopters.map((a) => a.login);
    expect(byPromptTokens[0]).toBe("alice");

    const byOutputTokens = getCopilotAppAdopters(START, END, 1, 10, "outputTokens", "desc").adopters.map((a) => a.login);
    expect(byOutputTokens[0]).toBe("alice");

    // Numeric ascending sort: frank (sessions=0) < erin (sessions=1) < alice (sessions=5).
    const bySessionsAsc = getCopilotAppAdopters(START, END, 1, 10, "sessions", "asc").adopters.map((a) => a.login);
    expect(bySessionsAsc).toEqual(["frank", "erin", "alice"]);
  });

  it("falls back to sessions ordering for an invalid sort field, and to desc for an invalid direction", () => {
    const invalidSort = getCopilotAppAdopters(START, END, 1, 10, "not-a-real-field", "desc").adopters.map((a) => a.login);
    const sessionsSort = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc").adopters.map((a) => a.login);
    expect(invalidSort).toEqual(sessionsSort);

    // Invalid direction string should not throw and should behave like desc.
    const invalidDir = getCopilotAppAdopters(
      START, END, 1, 10, "sessions", "not-a-real-direction" as unknown as "asc",
    ).adopters.map((a) => a.login);
    expect(invalidDir).toEqual(sessionsSort);
  });

  it("paginates with page/pageSize/offset and returns a consistent total", () => {
    const page1 = getCopilotAppAdopters(START, END, 1, 2, "login", "asc");
    const page2 = getCopilotAppAdopters(START, END, 2, 2, "login", "asc");
    expect(page1.adopters).toHaveLength(2);
    expect(page2.adopters).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
    expect([...page1.adopters, ...page2.adopters].map((a) => a.login)).toEqual(["alice", "erin", "frank"]);
  });

  it("search and pagination remain mutually consistent across pages", () => {
    // "a" matches alice and frank (both contain the letter 'a'), not erin.
    const page1 = getCopilotAppAdopters(START, END, 1, 1, "login", "asc", "a");
    const page2 = getCopilotAppAdopters(START, END, 2, 1, "login", "asc", "a");
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(page1.adopters).toHaveLength(1);
    expect(page2.adopters).toHaveLength(1);
    expect([...page1.adopters, ...page2.adopters].map((a) => a.login)).toEqual(["alice", "frank"]);
  });

  it("returns empty for an explicit empty allowedLogins array, and unfiltered results for undefined", () => {
    const empty = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc", undefined, []);
    expect(empty.adopters).toEqual([]);
    expect(empty.total).toBe(0);

    const unfiltered = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc", undefined, undefined);
    expect(unfiltered.total).toBe(3);
  });

  it("excludes a row with used_copilot_app=false, null dedicated totals, and no App feature row (dave), and also excludes an all-zero supported row (bob)", () => {
    // dave (2025-04-03): used_copilot_app=0, totals_by_copilot_app=NULL, and
    // no copilot_app entry in totals_by_feature — none of the adopter
    // activity signals are present, so he must be excluded.
    // bob (2025-04-01): used_copilot_app=0 and a non-null but all-zero
    // totals_by_copilot_app object — schema support without any actual
    // activity, so he is excluded too under the activity-aligned semantics.
    const { adopters, total } = getCopilotAppAdopters("2025-04-01", "2025-04-03", 1, 10, "sessions", "desc");
    const logins = adopters.map((a) => a.login).sort();
    expect(logins).toEqual(["alice", "erin", "frank"]);
    expect(logins).not.toContain("dave");
    expect(logins).not.toContain("bob");
    expect(total).toBe(3);
  });

  it("clamps page to a minimum of 1 for page<=0 and truncates fractional page numbers", () => {
    const zero = getCopilotAppAdopters("2025-05-01", "2025-05-01", 0, 10, "login", "asc");
    const negative = getCopilotAppAdopters("2025-05-01", "2025-05-01", -5, 10, "login", "asc");
    const one = getCopilotAppAdopters("2025-05-01", "2025-05-01", 1, 10, "login", "asc");
    expect(zero.adopters).toEqual(one.adopters);
    expect(negative.adopters).toEqual(one.adopters);

    const fractional = getCopilotAppAdopters("2025-05-01", "2025-05-01", 1.9, 10, "login", "asc");
    expect(fractional.adopters).toEqual(one.adopters);
  });

  it("clamps pageSize to a minimum of 1 for pageSize<=0", () => {
    const zero = getCopilotAppAdopters("2025-05-01", "2025-05-01", 1, 0, "login", "asc");
    expect(zero.adopters).toHaveLength(1);
    expect(zero.total).toBe(205);

    const negative = getCopilotAppAdopters("2025-05-01", "2025-05-01", 1, -20, "login", "asc");
    expect(negative.adopters).toHaveLength(1);
  });

  it("clamps pageSize to a maximum of 200 for pageSize>200", () => {
    const result = getCopilotAppAdopters("2025-05-01", "2025-05-01", 1, 500, "login", "asc");
    expect(result.adopters).toHaveLength(200);
    expect(result.total).toBe(205);
  });

  it("normalizes an invalid runtime sortDir to desc despite the TS type, without throwing", () => {
    const invalid = getCopilotAppAdopters(
      START, END, 1, 10, "sessions", "banana" as unknown as "asc" | "desc",
    );
    const desc = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc");
    expect(invalid.adopters.map((a) => a.login)).toEqual(desc.adopters.map((a) => a.login));
  });

  it("returns an empty adopter array but the correct total when the requested page is beyond the final page", () => {
    // Scope has 3 adopters total; requesting page 99 with pageSize 10 is far
    // beyond the last page, so the primary windowed query returns zero rows
    // and the count-only fallback must still report the true total.
    const beyond = getCopilotAppAdopters(START, END, 99, 10, "sessions", "desc");
    expect(beyond.adopters).toEqual([]);
    expect(beyond.total).toBe(3);
  });

  it("falls back to sessions ordering (never throws or emits invalid SQL) for prototype-property sortField values", () => {
    // A plain-object lookup (`ADOPTER_SORT_COLUMNS[sortField] ?? "sessions"`)
    // would resolve "constructor"/"toString" through the prototype chain to
    // an inherited function instead of missing the allowlist, bypassing the
    // `??` fallback and interpolating that function into the ORDER BY
    // clause as invalid SQL. "__proto__" is a further special case some
    // object-key handling mishandles entirely. All three must behave
    // identically to the documented "sessions" fallback.
    const sessionsSort = getCopilotAppAdopters(START, END, 1, 10, "sessions", "desc").adopters.map((a) => a.login);

    for (const sortField of ["constructor", "toString", "__proto__"]) {
      const result = getCopilotAppAdopters(START, END, 1, 10, sortField, "desc");
      expect(result.adopters.map((a) => a.login)).toEqual(sessionsSort);
      expect(result.total).toBe(3);
    }
  });

  it("caps an astronomically large finite page (1e308) to MAX_ADOPTER_PAGE without throwing, returning an empty page with the correct total", () => {
    // 1e308 is finite but its (page - 1) * pageSize offset would otherwise
    // be far beyond Number.MAX_SAFE_INTEGER (and, depending on pageSize,
    // could even compute to Infinity) — this must be capped rather than
    // fed directly into the SQL OFFSET.
    expect(() => getCopilotAppAdopters(START, END, 1e308, 10, "sessions", "desc")).not.toThrow();
    const result = getCopilotAppAdopters(START, END, 1e308, 10, "sessions", "desc");
    expect(result.adopters).toEqual([]);
    expect(result.total).toBe(3);
  });

  it("caps a page value that would overflow MAX_SAFE_INTEGER after multiplication by pageSize, without throwing", () => {
    // Number.MAX_SAFE_INTEGER as `page` with the max pageSize (200) would
    // compute an offset of (MAX_SAFE_INTEGER - 1) * 200, which overflows
    // Number.MAX_SAFE_INTEGER and loses integer precision if not capped.
    const hugePage = Number.MAX_SAFE_INTEGER;
    expect(() => getCopilotAppAdopters(START, END, hugePage, 200, "sessions", "desc")).not.toThrow();
    const result = getCopilotAppAdopters(START, END, hugePage, 200, "sessions", "desc");
    expect(result.adopters).toEqual([]);
    expect(result.total).toBe(3);
  });

  it("uses the documented default page size (50) for a non-finite pageSize (NaN/Infinity)", () => {
    // 205-row scope: a default of 50 should return a full 50-row first page,
    // distinct from the `1`-row floor applied to finite-but-invalid sizes
    // like 0 or -20 (covered by the pageSize<=0 test above).
    const nan = getCopilotAppAdopters("2025-05-01", "2025-05-01", 1, NaN, "login", "asc");
    expect(nan.adopters).toHaveLength(50);
    expect(nan.total).toBe(205);

    const infinite = getCopilotAppAdopters("2025-05-01", "2025-05-01", 1, Infinity, "login", "asc");
    expect(infinite.adopters).toHaveLength(50);
    expect(infinite.total).toBe(205);
  });
});
