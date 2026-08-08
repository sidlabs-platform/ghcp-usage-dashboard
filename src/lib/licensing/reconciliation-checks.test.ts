import { describe, it, expect } from "vitest";
import {
  checkSeatCount,
  checkRealLoginCoverage,
  checkExternalIdentityLeak,
  checkStatusAgreement,
  checkAicGrossVsNet,
  checkConsumptionAttribution,
  checkHistoryCoverage,
  deriveOverallRunStatus,
  summarizeSourceStates,
  summarizeHistoryCoverage,
  summarizeIdentityResolution,
  type ReconciliationCheckResult,
  type AuthoritativeStatus,
} from "./reconciliation-checks";
import type { MaterializedLicensePeriodRow } from "./materialize-license-period";
import type { SeatLedgerCoverage } from "./seat-ledger";

const PERIOD = "2026-06";

function row(overrides: Partial<MaterializedLicensePeriodRow> = {}): MaterializedLicensePeriodRow {
  return {
    enterpriseSlug: "acme-corp",
    billingPeriod: PERIOD,
    orgLogin: "org1",
    holderKey: "user1",
    githubUserId: 1,
    userLogin: "user1",
    resolvedUserLogin: "user1",
    externalIdentity: null,
    identityResolutionSource: "seat",
    accountState: "member",
    licenseAssignedDate: "2026-06-01",
    userRevokedDate: null,
    planType: "business",
    seatStatus: "active",
    assignedVia: "direct",
    lastActivityAt: "2026-06-15T00:00:00Z",
    licenseCost: 19,
    defaultAicCredits: 1900,
    defaultAicUsd: 19,
    aicAssignedUsd: 19,
    aicAssignedRule: "plan_default",
    aicConsumedCredits: 100,
    aicConsumedUsd: 1,
    currency: "USD",
    rowSource: "seat_ledger",
    consumptionSource: "billing_report",
    historyConfidence: "exact_snapshot",
    dataQualityNotes: [],
    utilizationPct: 5.26,
    overageCredits: 0,
    overageUsd: 0,
    totalCost: 19,
    asOfUtc: "2026-06-30T23:59:59Z",
    generatedAtUtc: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function coverage(overrides: Partial<SeatLedgerCoverage> = {}): SeatLedgerCoverage {
  return {
    enterpriseSlug: "acme-corp",
    billingPeriod: PERIOD,
    orgLogin: "org1",
    confidence: "exact_snapshot",
    counts: { exact_snapshot: 1, audit_reconstructed: 0, live_snapshot_only: 0, unrecoverable: 0 },
    warnings: [],
    ...overrides,
  };
}

describe("checkSeatCount", () => {
  it("passes when the materialized active-seat count matches the authoritative count exactly", () => {
    const rows = [row({ holderKey: "u1" }), row({ holderKey: "u2" })];
    const results = checkSeatCount({
      materializedRows: rows,
      authoritativeSeatCounts: [{ billingPeriod: PERIOD, orgLogin: "org1", totalSeats: 2 }],
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "seat_count", status: "pass", billingPeriod: PERIOD, orgLogin: "org1" });
    expect(results[0].actualValue).toBe(2);
    expect(results[0].expectedValue).toBe(2);
  });

  it("warns on a defensible small variance (off by 1)", () => {
    const rows = [row({ holderKey: "u1" }), row({ holderKey: "u2" })];
    const results = checkSeatCount({
      materializedRows: rows,
      authoritativeSeatCounts: [{ billingPeriod: PERIOD, orgLogin: "org1", totalSeats: 3 }],
    });
    expect(results[0].status).toBe("warning");
  });

  it("fails on a substantive mismatch", () => {
    const rows = [row({ holderKey: "u1" })];
    const results = checkSeatCount({
      materializedRows: rows,
      authoritativeSeatCounts: [{ billingPeriod: PERIOD, orgLogin: "org1", totalSeats: 10 }],
    });
    expect(results[0].status).toBe("fail");
  });

  it("warns (never pass/fail/throw) when no authoritative comparator is present", () => {
    const rows = [row({ holderKey: "u1" })];
    const results = checkSeatCount({ materializedRows: rows });
    expect(results[0].status).toBe("warning");
    expect(results[0].expectedValue).toBeNull();
    expect(() => checkSeatCount({ materializedRows: rows })).not.toThrow();
  });

  it("only counts active seats, ignoring inactive/no_seat rows", () => {
    const rows = [row({ holderKey: "u1", seatStatus: "active" }), row({ holderKey: "u2", seatStatus: "inactive" })];
    const results = checkSeatCount({
      materializedRows: rows,
      authoritativeSeatCounts: [{ billingPeriod: PERIOD, orgLogin: "org1", totalSeats: 1 }],
    });
    expect(results[0].status).toBe("pass");
    expect(results[0].actualValue).toBe(1);
  });

  it("groups independently per (billingPeriod, orgLogin)", () => {
    const rows = [row({ orgLogin: "org1", holderKey: "u1" }), row({ orgLogin: "org2", holderKey: "u2" })];
    const results = checkSeatCount({
      materializedRows: rows,
      authoritativeSeatCounts: [
        { billingPeriod: PERIOD, orgLogin: "org1", totalSeats: 1 },
        { billingPeriod: PERIOD, orgLogin: "org2", totalSeats: 99 },
      ],
    });
    expect(results).toHaveLength(2);
    const org1 = results.find((r) => r.orgLogin === "org1");
    const org2 = results.find((r) => r.orgLogin === "org2");
    expect(org1?.status).toBe("pass");
    expect(org2?.status).toBe("fail");
  });

  it("respects a custom variance tolerance", () => {
    const rows = [row({ holderKey: "u1" }), row({ holderKey: "u2" }), row({ holderKey: "u3" })];
    const results = checkSeatCount({
      materializedRows: rows,
      authoritativeSeatCounts: [{ billingPeriod: PERIOD, orgLogin: "org1", totalSeats: 5 }],
      varianceToleranceSeats: 5,
    });
    expect(results[0].status).toBe("warning");
  });
});

describe("checkRealLoginCoverage", () => {
  it("passes with full (100%) real-login coverage", () => {
    const rows = [row({ holderKey: "u1" }), row({ holderKey: "u2" })];
    const results = checkRealLoginCoverage({ materializedRows: rows });
    expect(results[0]).toMatchObject({ status: "pass", actualValue: 100 });
    expect(results[0].details.unresolvedHolderKeys).toEqual([]);
  });

  it("warns on partial coverage above the fail threshold", () => {
    const rows = [
      row({ holderKey: "u1" }),
      row({ holderKey: "u2" }),
      row({ holderKey: "u3" }),
      row({ holderKey: "u4" }),
      row({ holderKey: "u5" }),
      row({ holderKey: "u6" }),
      row({ holderKey: "u7" }),
      row({ holderKey: "u8" }),
      row({ holderKey: "u9" }),
      row({ holderKey: "u10", identityResolutionSource: "unresolved", resolvedUserLogin: null }),
    ];
    const results = checkRealLoginCoverage({ materializedRows: rows });
    expect(results[0].status).toBe("warning");
    expect(results[0].actualValue).toBe(90);
  });

  it("fails on severely low coverage", () => {
    const rows = [
      row({ holderKey: "u1" }),
      row({ holderKey: "u2", identityResolutionSource: "unresolved", resolvedUserLogin: null }),
      row({ holderKey: "u3", identityResolutionSource: "unresolved", resolvedUserLogin: null }),
    ];
    const results = checkRealLoginCoverage({ materializedRows: rows });
    expect(results[0].status).toBe("fail");
  });

  it("reports unresolved holder keys sorted, safe (holderKey only)", () => {
    const rows = [
      row({ holderKey: "zeta", identityResolutionSource: "unresolved", resolvedUserLogin: null }),
      row({ holderKey: "alpha", identityResolutionSource: "unresolved", resolvedUserLogin: null }),
    ];
    const results = checkRealLoginCoverage({ materializedRows: rows });
    expect(results[0].details.unresolvedHolderKeys).toEqual(["alpha", "zeta"]);
    expect(JSON.stringify(results[0].details)).not.toMatch(/@|external/i);
  });

  it("passes trivially for an empty group", () => {
    const results = checkRealLoginCoverage({ materializedRows: [] });
    expect(results).toEqual([]);
  });
});

describe("checkExternalIdentityLeak", () => {
  it("passes for a normal verified-tier resolved login", () => {
    const results = checkExternalIdentityLeak({ materializedRows: [row({ identityResolutionSource: "seat", resolvedUserLogin: "octocat" })] });
    expect(results[0].status).toBe("pass");
  });

  it("fails when an unvalidated-mapping-tier login matches a known external identity", () => {
    const results = checkExternalIdentityLeak({
      materializedRows: [row({ identityResolutionSource: "identity_map", resolvedUserLogin: "leaked-value" })],
      knownExternalIdentities: ["leaked-value"],
    });
    expect(results[0].status).toBe("fail");
    expect(results[0].message).not.toMatch(/leaked-value/);
  });

  it("fails when an unvalidated-mapping-tier login looks like an email", () => {
    const results = checkExternalIdentityLeak({
      materializedRows: [row({ identityResolutionSource: "enterprise_identity", resolvedUserLogin: "person@example.com" })],
    });
    expect(results[0].status).toBe("fail");
    expect(JSON.stringify(results[0])).not.toMatch(/@example\.com/);
  });

  it("fails when an unvalidated-mapping-tier login looks like a GUID", () => {
    const results = checkExternalIdentityLeak({
      materializedRows: [row({ identityResolutionSource: "org_identity", resolvedUserLogin: "550e8400-e29b-41d4-a716-446655440000" })],
    });
    expect(results[0].status).toBe("fail");
  });

  it("never flags a seat/audit-resolved login even if it happens to be hex-like (conservative, no false positives)", () => {
    const results = checkExternalIdentityLeak({
      materializedRows: [row({ identityResolutionSource: "seat", resolvedUserLogin: "deadbeef" })],
    });
    expect(results[0].status).toBe("pass");
  });

  it("passes for unresolved holders (no resolvedUserLogin to check)", () => {
    const results = checkExternalIdentityLeak({
      materializedRows: [row({ identityResolutionSource: "unresolved", resolvedUserLogin: null })],
    });
    expect(results[0].status).toBe("pass");
  });

  it("reports affected count and only holderKey, never the leaked value, in details", () => {
    const results = checkExternalIdentityLeak({
      materializedRows: [row({ holderKey: "hkey1", identityResolutionSource: "identity_map", resolvedUserLogin: "some_bad_value" })],
    });
    expect(results[0].affectedCount).toBe(1);
    expect(results[0].details.affectedHolderKeys).toEqual(["hkey1"]);
  });
});

describe("checkStatusAgreement", () => {
  it("passes when materialized and authoritative status agree", () => {
    const results = checkStatusAgreement({
      materializedRows: [row({ holderKey: "u1", seatStatus: "active" })],
      authoritativeStatuses: [{ billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u1", status: "active" }],
    });
    expect(results[0].status).toBe("pass");
  });

  it("warns when no independent comparator is present", () => {
    const results = checkStatusAgreement({ materializedRows: [row({ holderKey: "u1" })] });
    expect(results[0].status).toBe("warning");
  });

  it("warns on a low mismatch rate", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ holderKey: `u${i}`, seatStatus: "active" }));
    const authoritative: AuthoritativeStatus[] = rows.map((r) => ({ billingPeriod: PERIOD, orgLogin: "org1", holderKey: r.holderKey, status: "active" }));
    authoritative[0] = { ...authoritative[0], status: "inactive" };
    const results = checkStatusAgreement({ materializedRows: rows, authoritativeStatuses: authoritative });
    expect(results[0].status).toBe("warning");
  });

  it("fails on a high mismatch rate", () => {
    const rows = [row({ holderKey: "u1", seatStatus: "active" }), row({ holderKey: "u2", seatStatus: "active" })];
    const authoritative = [
      { billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u1", status: "inactive" as const },
      { billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u2", status: "inactive" as const },
    ];
    const results = checkStatusAgreement({ materializedRows: rows, authoritativeStatuses: authoritative });
    expect(results[0].status).toBe("fail");
  });
});

describe("checkAicGrossVsNet", () => {
  it("passes within tolerance", () => {
    const results = checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 98 }] });
    expect(results[0].status).toBe("pass");
  });

  it("warns on a modest variance", () => {
    const results = checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 91 }] });
    expect(results[0].status).toBe("warning");
  });

  it("fails on a major variance", () => {
    const results = checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 50 }] });
    expect(results[0].status).toBe("fail");
  });

  it("warns when the net comparator is missing", () => {
    const results = checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: null }] });
    expect(results[0].status).toBe("warning");
  });

  it("never divides by zero or produces NaN when both gross and net are zero", () => {
    const results = checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 0, netUsd: 0 }] });
    expect(results[0].status).toBe("pass");
    expect(Number.isNaN(results[0].details.diffPct)).toBe(false);
  });

  it("supports an explicit tolerance override", () => {
    const results = checkAicGrossVsNet({
      comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 90 }],
      tolerancePct: 15,
    });
    expect(results[0].status).toBe("pass");
  });

  it("validates the tolerance override, throwing on an invalid value", () => {
    expect(() =>
      checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 100 }], tolerancePct: -1 })
    ).toThrow();
    expect(() =>
      checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 100 }], tolerancePct: NaN })
    ).toThrow();
  });

  it("rejects a tolerance override above 100, aligned with the config's 0..100 inclusive validation range", () => {
    expect(() =>
      checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 100 }], tolerancePct: 101 })
    ).toThrow();
    expect(() =>
      checkAicGrossVsNet({ comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 100 }], tolerancePct: Infinity })
    ).toThrow();
  });

  it("accepts the inclusive 100 boundary as a valid tolerance override", () => {
    const results = checkAicGrossVsNet({
      comparisons: [{ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 1 }],
      tolerancePct: 100,
    });
    expect(results[0].status).toBe("pass");
    expect(results[0].details.toleranceUsedPct).toBe(100);
  });

  it("keeps the default 5% tolerance and pure-function semantics when no override is given", () => {
    const before = { billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 94.9 };
    const results = checkAicGrossVsNet({ comparisons: [before] });
    // Default tolerance is 5%: a 5.1% variance must warn, not pass.
    expect(results[0].status).toBe("warning");
    expect(results[0].details.toleranceUsedPct).toBe(5);
    // Pure function: input object must be unchanged.
    expect(before).toEqual({ billingPeriod: PERIOD, orgLogin: "org1", grossUsd: 100, netUsd: 94.9 });
  });
});

describe("checkConsumptionAttribution", () => {
  it("passes for canonical single-org attribution", () => {
    const results = checkConsumptionAttribution({
      records: [{ billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u1", credits: 100, grossUsd: 1 }],
    });
    expect(results[0].status).toBe("pass");
  });

  it("passes for a single (unattributed) enterprise-only row", () => {
    const results = checkConsumptionAttribution({
      records: [{ billingPeriod: PERIOD, orgLogin: "(unattributed)", holderKey: "u1", credits: 100, grossUsd: 1 }],
    });
    expect(results[0].status).toBe("warning");
  });

  it("does not flag legitimate distinct-value multi-org attribution for the same holder", () => {
    const results = checkConsumptionAttribution({
      records: [
        { billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u1", credits: 100, grossUsd: 1 },
        { billingPeriod: PERIOD, orgLogin: "org2", holderKey: "u1", credits: 200, grossUsd: 2 },
      ],
    });
    expect(results[0].status).toBe("pass");
  });

  it("fails when identical non-zero consumption is duplicated verbatim across two distinct orgs", () => {
    const results = checkConsumptionAttribution({
      records: [
        { billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u1", credits: 100, grossUsd: 1 },
        { billingPeriod: PERIOD, orgLogin: "org2", holderKey: "u1", credits: 100, grossUsd: 1 },
      ],
    });
    expect(results[0].status).toBe("fail");
  });

  it("fails on a duplicate canonical (org, holder) key", () => {
    const results = checkConsumptionAttribution({
      records: [
        { billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u1", credits: 100, grossUsd: 1 },
        { billingPeriod: PERIOD, orgLogin: "org1", holderKey: "u1", credits: 50, grossUsd: 0.5 },
      ],
    });
    expect(results[0].status).toBe("fail");
  });
});

describe("checkHistoryCoverage", () => {
  it("passes for exact_snapshot coverage", () => {
    const results = checkHistoryCoverage({ coverage: [coverage({ confidence: "exact_snapshot" })] });
    expect(results[0].status).toBe("pass");
  });

  it("passes for audit_reconstructed coverage", () => {
    const results = checkHistoryCoverage({ coverage: [coverage({ confidence: "audit_reconstructed" })] });
    expect(results[0].status).toBe("pass");
  });

  it("warns for live_snapshot_only coverage", () => {
    const results = checkHistoryCoverage({ coverage: [coverage({ confidence: "live_snapshot_only" })] });
    expect(results[0].status).toBe("warning");
  });

  it("fails for unrecoverable coverage", () => {
    const results = checkHistoryCoverage({ coverage: [coverage({ confidence: "unrecoverable" })] });
    expect(results[0].status).toBe("fail");
  });

  it("warns with a valid summary when historical source data is entirely missing", () => {
    const results = checkHistoryCoverage({ coverage: [], expectedGroups: [{ billingPeriod: PERIOD, orgLogin: "org1" }] });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warning");
    expect(results[0].details.confidence).toBeNull();
  });
});

describe("deriveOverallRunStatus", () => {
  const pass: ReconciliationCheckResult = {
    name: "seat_count",
    status: "pass",
    message: "ok",
    billingPeriod: PERIOD,
    orgLogin: "org1",
    expectedValue: null,
    actualValue: null,
    affectedCount: 0,
    details: {},
  };

  it("returns success when all checks pass", () => {
    expect(deriveOverallRunStatus([pass, { ...pass, name: "history_coverage" }])).toBe("success");
  });

  it("returns warning when any check warns and none fail", () => {
    expect(deriveOverallRunStatus([pass, { ...pass, status: "warning" }])).toBe("warning");
  });

  it("returns failed when any check fails", () => {
    expect(deriveOverallRunStatus([pass, { ...pass, status: "fail" }, { ...pass, status: "warning" }])).toBe("failed");
  });

  it("returns warning (never success) for an empty check set", () => {
    expect(deriveOverallRunStatus([])).toBe("warning");
  });
});

describe("summarizeSourceStates", () => {
  it("groups and sorts sources alphabetically, periods within a source by billingPeriod", () => {
    const summary = summarizeSourceStates([
      { source: "seat_snapshot", billingPeriod: "2026-02", status: "ok" },
      { source: "audit_log", billingPeriod: "2026-01", status: "ok" },
      { source: "seat_snapshot", billingPeriod: "2026-01", status: "ok" },
    ]);
    expect(summary.map((s) => s.source)).toEqual(["audit_log", "seat_snapshot"]);
    expect(summary[1].periods.map((p) => p.billingPeriod)).toEqual(["2026-01", "2026-02"]);
  });

  it("returns an empty array for no states", () => {
    expect(summarizeSourceStates([])).toEqual([]);
  });
});

describe("summarizeHistoryCoverage", () => {
  it("counts by confidence tier, sorted alphabetically", () => {
    const summary = summarizeHistoryCoverage([
      coverage({ confidence: "unrecoverable" }),
      coverage({ confidence: "exact_snapshot" }),
      coverage({ confidence: "exact_snapshot" }),
    ]);
    expect(summary).toEqual([
      { confidence: "exact_snapshot", count: 2 },
      { confidence: "unrecoverable", count: 1 },
    ]);
  });
});

describe("summarizeIdentityResolution", () => {
  it("groups by source and lists unresolved holder keys, sorted, safely", () => {
    const summary = summarizeIdentityResolution([
      { holderKey: "u1", identityResolutionSource: "seat", resolvedUserLogin: "u1" },
      { holderKey: "u2", identityResolutionSource: "unresolved", resolvedUserLogin: null },
      { holderKey: "u3", identityResolutionSource: "audit", resolvedUserLogin: "u3" },
    ]);
    expect(summary.bySource).toEqual([
      { source: "audit", count: 1 },
      { source: "seat", count: 1 },
      { source: "unresolved", count: 1 },
    ]);
    expect(summary.unresolvedHolderKeys).toEqual(["u2"]);
  });
});
