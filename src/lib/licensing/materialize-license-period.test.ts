import { describe, it, expect } from "vitest";
import {
  materializeLicensePeriodRows,
  normalizePlanKey,
  licensePeriodCanonicalKey,
  CONSUMPTION_SOURCE_PRECEDENCE,
  UNATTRIBUTED_ORG,
  type MaterializeLicensePeriodInput,
  type ConsumptionRecordInput,
} from "./materialize-license-period";
import type { SeatLedgerRow } from "./seat-ledger";
import type { ResolvedIdentity } from "./identity-resolver";
import type { ResolvedLicensingConfig } from "@/lib/config/dashboard-config";

// ── Fixtures ────────────────────────────────────────────────────────────

const ENT = "acme-corp";
const PERIOD = "2026-06";

function baseConfig(overrides: Partial<ResolvedLicensingConfig> = {}): ResolvedLicensingConfig {
  return {
    creditToUsd: 0.01,
    currency: "USD",
    licenseCost: { business: 19, enterprise: 39, unknown: 0 },
    aicAllowance: { business: 1900, enterprise: 3900, unknown: 0 },
    perUserBudgetUsd: {},
    datedAllowances: [],
    history: {
      enabled: true,
      reportMonths: [PERIOD],
      auditRetentionDays: 400,
      emitSnapshots: false,
      snapshotDirectory: "data/licensing-snapshots",
      auditArchivePath: "data/licensing-audit",
      identityMapPath: "data/identity-map.json",
    },
    identity: { fetchMembership: false, fetchEnterpriseIdentities: false, fetchOrgIdentities: false },
    aicConsumption: { mode: "auto", concurrency: 4 },
    validation: { enabled: true, aicTolerancePct: 5 },
    ...overrides,
  };
}

function seatRow(overrides: Partial<SeatLedgerRow> = {}): SeatLedgerRow {
  return {
    enterpriseSlug: ENT,
    billingPeriod: PERIOD,
    orgLogin: "org1",
    holderKey: "user1",
    githubUserId: 1,
    observedLogin: "user1",
    assignedAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
    confidence: "exact_snapshot",
    source: "exact_snapshot",
    ...overrides,
  };
}

function identity(overrides: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
  return {
    holderKey: "user1",
    githubUserId: 1,
    userLogin: "user1",
    resolvedUserLogin: "user1",
    externalIdentity: null,
    source: "seat",
    accountState: "member",
    notes: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<MaterializeLicensePeriodInput> = {}): MaterializeLicensePeriodInput {
  return {
    enterpriseSlug: ENT,
    billingPeriod: PERIOD,
    seatRows: [seatRow()],
    identities: { user1: identity() },
    seatMetadata: { [licensePeriodCanonicalKey("org1", "user1")]: { planType: "business", assignedVia: "direct" } },
    config: baseConfig(),
    asOfUtc: "2026-06-30T23:59:59.000Z",
    generatedAtUtc: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("normalizePlanKey", () => {
  it("normalizes known plan aliases and defaults unknown/missing to 'unknown'", () => {
    expect(normalizePlanKey("copilot_business")).toBe("business");
    expect(normalizePlanKey("Copilot Enterprise")).toBe("enterprise");
    expect(normalizePlanKey("BUSINESS")).toBe("business");
    expect(normalizePlanKey("something_else")).toBe("unknown");
    expect(normalizePlanKey(null)).toBe("unknown");
    expect(normalizePlanKey("")).toBe("unknown");
  });
});

describe("licensePeriodCanonicalKey", () => {
  it("normalizes a missing/empty org to the UNATTRIBUTED_ORG sentinel", () => {
    expect(licensePeriodCanonicalKey(null, "user1")).toBe(`${UNATTRIBUTED_ORG}\u0000user1`);
    expect(licensePeriodCanonicalKey("", "user1")).toBe(`${UNATTRIBUTED_ORG}\u0000user1`);
    expect(licensePeriodCanonicalKey("org1", "user1")).toBe(`org1\u0000user1`);
  });
});

describe("materializeLicensePeriodRows: basic seat mapping", () => {
  it("produces one row per canonical (org, holder) with identity/seat fields preserved", () => {
    const result = materializeLicensePeriodRows(baseInput());
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.enterpriseSlug).toBe(ENT);
    expect(row.billingPeriod).toBe(PERIOD);
    expect(row.orgLogin).toBe("org1");
    expect(row.holderKey).toBe("user1");
    expect(row.githubUserId).toBe(1);
    expect(row.resolvedUserLogin).toBe("user1");
    expect(row.externalIdentity).toBeNull();
    expect(row.identityResolutionSource).toBe("seat");
    expect(row.accountState).toBe("member");
    expect(row.licenseAssignedDate).toBe("2026-01-01");
    expect(row.userRevokedDate).toBeNull();
    expect(row.assignedVia).toBe("direct");
    expect(row.historyConfidence).toBe("exact_snapshot");
    expect(row.rowSource).toBe("seat_ledger");
  });

  it("never puts external identity/email/SAML/SCIM values into the login fields", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        identities: {
          user1: identity({ userLogin: null, resolvedUserLogin: null, externalIdentity: "user1@example.com", source: "unresolved" }),
        },
      })
    );
    const row = result.rows[0];
    expect(row.userLogin).toBeNull();
    expect(row.resolvedUserLogin).toBeNull();
    expect(row.externalIdentity).toBe("user1@example.com");
  });

  it("defaults to an unresolved identity (from the seat's observed login) when no identity entry is supplied", () => {
    const result = materializeLicensePeriodRows(baseInput({ identities: {} }));
    const row = result.rows[0];
    expect(row.identityResolutionSource).toBe("unresolved");
    expect(row.resolvedUserLogin).toBe("user1");
    expect(row.dataQualityNotes.some((n) => n.includes("identity not resolved"))).toBe(true);
  });

  it("drops seat rows scoped to a different enterprise/period with a ledger-wide warning, never mixing them in", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatRows: [seatRow(), seatRow({ orgLogin: "org2", holderKey: "user2", enterpriseSlug: "other-ent" })],
      })
    );
    expect(result.rows).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("other-ent"))).toBe(true);
  });

  it("does not collapse users across organizations: two orgs for the same holder produce two rows", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatRows: [seatRow({ orgLogin: "org1" }), seatRow({ orgLogin: "org2" })],
        seatMetadata: {
          [licensePeriodCanonicalKey("org1", "user1")]: { planType: "business", assignedVia: "direct" },
          [licensePeriodCanonicalKey("org2", "user1")]: { planType: "enterprise", assignedVia: "team" },
        },
      })
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.orgLogin).sort()).toEqual(["org1", "org2"]);
  });
});

describe("materializeLicensePeriodRows: allowance selection", () => {
  it("falls back to the static plan allowance when no dated window matches", () => {
    const row = materializeLicensePeriodRows(baseInput()).rows[0];
    expect(row.defaultAicCredits).toBe(1900);
    expect(row.defaultAicUsd).toBe(19);
  });

  it("selects a dated allowance window that covers the billing period", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        config: baseConfig({
          datedAllowances: [{ start: "2026-05-01", end: "2026-07-31", credits: { business: 2500 } }],
        }),
      })
    );
    expect(result.rows[0].defaultAicCredits).toBe(2500);
    expect(result.rows[0].defaultAicUsd).toBe(25);
  });

  it("does not apply a dated window that does not cover the billing period", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        config: baseConfig({
          datedAllowances: [{ start: "2026-01-01", end: "2026-03-31", credits: { business: 2500 } }],
        }),
      })
    );
    expect(result.rows[0].defaultAicCredits).toBe(1900); // static fallback
  });

  it("supports an open-ended dated window (no end date)", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        config: baseConfig({
          datedAllowances: [{ start: "2026-06-01", credits: { business: 3000 } }],
        }),
      })
    );
    expect(result.rows[0].defaultAicCredits).toBe(3000);
  });

  it("normalizes plan names before allowance/cost lookup (alias -> canonical key)", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ seatMetadata: { [licensePeriodCanonicalKey("org1", "user1")]: { planType: "Copilot_Business", assignedVia: "direct" } } })
    );
    expect(result.rows[0].planType).toBe("business");
    expect(result.rows[0].licenseCost).toBe(19);
  });

  it("an unknown plan never silently receives a paid plan's price or allowance", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatMetadata: { [licensePeriodCanonicalKey("org1", "user1")]: { planType: "mystery_plan", assignedVia: "direct" } },
        config: baseConfig({
          datedAllowances: [{ start: "2026-01-01", credits: { business: 999999 } }],
        }),
      })
    );
    const row = result.rows[0];
    expect(row.planType).toBe("unknown");
    expect(row.licenseCost).toBe(0);
    expect(row.defaultAicCredits).toBe(0);
    expect(row.dataQualityNotes.some((n) => n.includes("mystery_plan"))).toBe(true);
  });
});

describe("materializeLicensePeriodRows: license cost / per-user budget", () => {
  it("computes monthly license cost from the normalized plan", () => {
    const row = materializeLicensePeriodRows(baseInput()).rows[0];
    expect(row.licenseCost).toBe(19);
  });

  it("uses a configured per-user budget override instead of the plan default", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ config: baseConfig({ perUserBudgetUsd: { user1: 50 } }) })
    );
    const row = result.rows[0];
    expect(row.aicAssignedUsd).toBe(50);
    expect(row.aicAssignedRule).toBe("per_user_budget");
  });

  it("falls back to the plan default budget when no per-user override is configured", () => {
    const row = materializeLicensePeriodRows(baseInput()).rows[0];
    expect(row.aicAssignedUsd).toBe(19);
    expect(row.aicAssignedRule).toBe("plan_default");
  });
});

describe("materializeLicensePeriodRows: active/inactive status and cancellation", () => {
  it("marks a seat active when never revoked", () => {
    const row = materializeLicensePeriodRows(baseInput()).rows[0];
    expect(row.seatStatus).toBe("active");
    expect(row.userRevokedDate).toBeNull();
  });

  it("marks a seat inactive and surfaces the cancellation date when revoked within the period", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ seatRows: [seatRow({ revokedAt: "2026-06-15T00:00:00.000Z" })] })
    );
    const row = result.rows[0];
    expect(row.seatStatus).toBe("inactive");
    expect(row.userRevokedDate).toBe("2026-06-15");
  });

  it("keeps a seat active when revocation lands after the period end (still active throughout)", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ seatRows: [seatRow({ revokedAt: "2026-08-01T00:00:00.000Z" })] })
    );
    expect(result.rows[0].seatStatus).toBe("active");
  });
});

describe("materializeLicensePeriodRows: assignment source/confidence/provenance/quality notes", () => {
  it("preserves the seat ledger confidence tier as historyConfidence", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ seatRows: [seatRow({ confidence: "audit_reconstructed" })] })
    );
    expect(result.rows[0].historyConfidence).toBe("audit_reconstructed");
  });

  // Regression coverage for all four real SeatLedgerConfidence values (not
  // just "audit_reconstructed" above) — this module's historyConfidence
  // field is a plain SeatLedgerConfidence pass-through (simplified from the
  // redundant `SeatLedgerConfidence | "unrecoverable"`, since "unrecoverable"
  // was already a member of that union).
  it("preserves exact_snapshot, live_snapshot_only, and unrecoverable confidence tiers unchanged", () => {
    for (const confidence of ["exact_snapshot", "live_snapshot_only", "unrecoverable"] as const) {
      const result = materializeLicensePeriodRows(baseInput({ seatRows: [seatRow({ confidence })] }));
      expect(result.rows[0].historyConfidence).toBe(confidence);
    }
  });

  it("passes through the assigned_via metadata when supplied", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ seatMetadata: { [licensePeriodCanonicalKey("org1", "user1")]: { planType: "business", assignedVia: "team" } } })
    );
    expect(result.rows[0].assignedVia).toBe("team");
  });

  it("defaults assigned_via to 'direct' with a data-quality note when metadata is missing", () => {
    const result = materializeLicensePeriodRows(baseInput({ seatMetadata: {} }));
    const row = result.rows[0];
    expect(row.assignedVia).toBe("direct");
    expect(row.dataQualityNotes.some((n) => n.includes("assigned_via unavailable"))).toBe(true);
  });
});

describe("materializeLicensePeriodRows: consumption source precedence", () => {
  const holderKey = "user1";
  const org = "org1";

  function consumption(source: ConsumptionRecordInput["source"], credits: number, grossUsd: number, orgLogin: string | null = org): ConsumptionRecordInput {
    return { source, orgLogin, holderKey, credits, grossUsd };
  }

  it("has the documented precedence order", () => {
    expect(CONSUMPTION_SOURCE_PRECEDENCE).toEqual(["csv_import", "enterprise_api", "org_api", "billing_report", "usage_metrics_fallback"]);
  });

  it("prefers csv_import over every other source", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        consumption: [
          consumption("usage_metrics_fallback", 10, 0.1),
          consumption("billing_report", 20, 0.2),
          consumption("enterprise_api", 30, 0.3),
          consumption("csv_import", 40, 0.4),
        ],
      })
    );
    const row = result.rows[0];
    expect(row.consumptionSource).toBe("csv_import");
    expect(row.aicConsumedCredits).toBe(40);
    expect(row.aicConsumedUsd).toBe(0.4);
  });

  it("prefers enterprise_api over org_api, billing_report, and usage_metrics_fallback", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        enterpriseApiUnavailable: true, // org_api eligible, but enterprise_api still wins
        consumption: [
          consumption("usage_metrics_fallback", 10, 0.1),
          consumption("billing_report", 20, 0.2),
          consumption("org_api", 30, 0.3),
          consumption("enterprise_api", 50, 0.5),
        ],
      })
    );
    expect(result.rows[0].consumptionSource).toBe("enterprise_api");
    expect(result.rows[0].aicConsumedCredits).toBe(50);
  });

  it("ignores org_api entirely unless the enterprise API was unavailable run-wide", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        enterpriseApiUnavailable: false,
        consumption: [consumption("org_api", 30, 0.3), consumption("billing_report", 20, 0.2)],
      })
    );
    expect(result.rows[0].consumptionSource).toBe("billing_report");
    expect(result.rows[0].aicConsumedCredits).toBe(20);
  });

  it("uses org_api when the enterprise API was unavailable run-wide and no higher-precedence source has data", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        enterpriseApiUnavailable: true,
        consumption: [consumption("org_api", 30, 0.3), consumption("billing_report", 20, 0.2)],
      })
    );
    expect(result.rows[0].consumptionSource).toBe("org_api");
    expect(result.rows[0].aicConsumedCredits).toBe(30);
  });

  it("falls back to billing_report over usage_metrics_fallback", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ consumption: [consumption("usage_metrics_fallback", 10, 0.1), consumption("billing_report", 20, 0.2)] })
    );
    expect(result.rows[0].consumptionSource).toBe("billing_report");
  });

  it("uses usage_metrics_fallback (explicitly marked) as the last resort", () => {
    const result = materializeLicensePeriodRows(baseInput({ consumption: [consumption("usage_metrics_fallback", 10, 0.1)] }));
    expect(result.rows[0].consumptionSource).toBe("usage_metrics_fallback");
    expect(result.rows[0].aicConsumedCredits).toBe(10);
  });

  it("does not sum competing sources: only the chosen source's values are reflected", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        consumption: [consumption("csv_import", 5, 0.05), consumption("billing_report", 1000, 10)],
      })
    );
    expect(result.rows[0].aicConsumedCredits).toBe(5);
    expect(result.rows[0].aicConsumedUsd).toBe(0.05);
  });
});

describe("materializeLicensePeriodRows: duplicate aggregation and org attribution", () => {
  it("aggregates duplicate rows within the chosen source at the same canonical org/holder grain", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        consumption: [
          { source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 10, grossUsd: 0.1 },
          { source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 15, grossUsd: 0.15 },
        ],
      })
    );
    expect(result.rows[0].aicConsumedCredits).toBe(25);
    expect(result.rows[0].aicConsumedUsd).toBe(0.25);
  });

  it("keeps org-attributed consumption on its own org and does not blend it with another org's consumption for the same holder", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatRows: [seatRow({ orgLogin: "org1" }), seatRow({ orgLogin: "org2" })],
        seatMetadata: {
          [licensePeriodCanonicalKey("org1", "user1")]: { planType: "business", assignedVia: "direct" },
          [licensePeriodCanonicalKey("org2", "user1")]: { planType: "business", assignedVia: "direct" },
        },
        consumption: [
          { source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 10, grossUsd: 0.1 },
          { source: "billing_report", orgLogin: "org2", holderKey: "user1", credits: 40, grossUsd: 0.4 },
        ],
      })
    );
    const org1Row = result.rows.find((r) => r.orgLogin === "org1")!;
    const org2Row = result.rows.find((r) => r.orgLogin === "org2")!;
    expect(org1Row.aicConsumedCredits).toBe(10);
    expect(org2Row.aicConsumedCredits).toBe(40);
  });

  it("produces exactly one (unattributed) row for enterprise-only consumption, never copied to every org the holder belongs to", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatRows: [seatRow({ orgLogin: "org1" }), seatRow({ orgLogin: "org2" })],
        seatMetadata: {
          [licensePeriodCanonicalKey("org1", "user1")]: { planType: "business", assignedVia: "direct" },
          [licensePeriodCanonicalKey("org2", "user1")]: { planType: "business", assignedVia: "direct" },
        },
        consumption: [{ source: "billing_report", orgLogin: null, holderKey: "user1", credits: 100, grossUsd: 1 }],
      })
    );
    expect(result.rows).toHaveLength(3);
    const unattributedRows = result.rows.filter((r) => r.orgLogin === UNATTRIBUTED_ORG);
    expect(unattributedRows).toHaveLength(1);
    expect(unattributedRows[0].aicConsumedCredits).toBe(100);
    const org1Row = result.rows.find((r) => r.orgLogin === "org1")!;
    const org2Row = result.rows.find((r) => r.orgLogin === "org2")!;
    expect(org1Row.aicConsumedCredits).toBe(0);
    expect(org2Row.aicConsumedCredits).toBe(0);
  });

  it("synthesizes a consumption-only row (no seat) when consumption has no matching seat assignment", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ consumption: [{ source: "billing_report", orgLogin: "org9", holderKey: "ghost", credits: 5, grossUsd: 0.05 }] })
    );
    const ghostRow = result.rows.find((r) => r.holderKey === "ghost")!;
    expect(ghostRow).toBeDefined();
    expect(ghostRow.rowSource).toBe("consumption_only");
    expect(ghostRow.seatStatus).toBe("no_seat");
    expect(ghostRow.licenseCost).toBe(0);
  });
});

describe("materializeLicensePeriodRows: utilization / overage / total cost", () => {
  it("computes utilization percentage against the assigned budget", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ consumption: [{ source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 950, grossUsd: 9.5 }] })
    );
    // aicAssignedUsd defaults to plan default (19 USD); 9.5/19 = 50%
    expect(result.rows[0].utilizationPct).toBe(50);
  });

  it("returns 0% utilization with safe zero-budget semantics (no assigned or default budget)", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatMetadata: { [licensePeriodCanonicalKey("org1", "user1")]: { planType: "unknown", assignedVia: "direct" } },
      })
    );
    expect(result.rows[0].utilizationPct).toBe(0);
    expect(result.rows[0].defaultAicUsd).toBe(0);
  });

  it("computes overage credits/usd as zero when under budget", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ consumption: [{ source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 100, grossUsd: 1 }] })
    );
    expect(result.rows[0].overageCredits).toBe(0);
    expect(result.rows[0].overageUsd).toBe(0);
    expect(result.rows[0].totalCost).toBe(19); // license cost only
  });

  it("computes non-negative overage credits/usd when over budget", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ consumption: [{ source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 2500, grossUsd: 25 }] })
    );
    const row = result.rows[0];
    expect(row.overageCredits).toBe(600); // 2500 - 1900
    expect(row.overageUsd).toBe(6); // 25 - 19
    expect(row.overageUsd).toBeGreaterThanOrEqual(0);
  });

  it("computes total cost as license cost + overage only (never double-counts gross consumption covered by the allowance)", () => {
    const result = materializeLicensePeriodRows(
      baseInput({ consumption: [{ source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 2500, grossUsd: 25 }] })
    );
    expect(result.rows[0].totalCost).toBe(25); // 19 license + 6 overage, NOT 19 + 25
  });

  it("never produces NaN/Infinity for any numeric field", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatMetadata: { [licensePeriodCanonicalKey("org1", "user1")]: { planType: "unknown", assignedVia: "direct" } },
        consumption: [{ source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 0, grossUsd: 0 }],
      })
    );
    const row = result.rows[0];
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), `${key} should be finite`).toBe(true);
      }
    }
  });

  it("rounds monetary values to 2 decimal places deterministically", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        config: baseConfig({ creditToUsd: 0.013 }),
        consumption: [{ source: "billing_report", orgLogin: "org1", holderKey: "user1", credits: 333, grossUsd: 3.33333 }],
      })
    );
    const row = result.rows[0];
    expect(row.defaultAicUsd).toBe(Math.round(1900 * 0.013 * 100) / 100);
    expect(row.aicConsumedUsd).toBe(3.33);
  });
});

describe("materializeLicensePeriodRows: deterministic output order", () => {
  it("sorts rows by (orgLogin, holderKey) regardless of input order", () => {
    const result = materializeLicensePeriodRows(
      baseInput({
        seatRows: [
          seatRow({ orgLogin: "orgB", holderKey: "zeta" }),
          seatRow({ orgLogin: "orgA", holderKey: "alpha" }),
          seatRow({ orgLogin: "orgA", holderKey: "beta" }),
        ],
        seatMetadata: {
          [licensePeriodCanonicalKey("orgB", "zeta")]: { planType: "business" },
          [licensePeriodCanonicalKey("orgA", "alpha")]: { planType: "business" },
          [licensePeriodCanonicalKey("orgA", "beta")]: { planType: "business" },
        },
      })
    );
    expect(result.rows.map((r) => `${r.orgLogin}/${r.holderKey}`)).toEqual(["orgA/alpha", "orgA/beta", "orgB/zeta"]);
  });
});

describe("materializeLicensePeriodRows: validation", () => {
  it("throws on a malformed billing period", () => {
    expect(() => materializeLicensePeriodRows(baseInput({ billingPeriod: "not-a-period" }))).toThrow();
  });

  it("throws on a missing/empty enterpriseSlug", () => {
    expect(() => materializeLicensePeriodRows(baseInput({ enterpriseSlug: "  " }))).toThrow();
  });
});
