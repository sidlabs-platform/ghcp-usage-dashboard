// Monthly license reconciliation materializer (Task 7).
//
// Combines Task 6's seat ledger (`seat-ledger.ts`'s `SeatLedgerRow[]`) and
// resolved identities (`identity-resolver.ts`'s `ResolvedIdentity`) with
// per-source AI-Credit consumption evidence and configured pricing /
// allowances (`dashboard-config.ts`) into the canonical
// (enterpriseSlug, billingPeriod, orgLogin, holderKey) grain persisted by
// `license-history-repo.ts`'s `license_period_rows` table.
//
// Two halves live in this single file:
//   - `materializeLicensePeriodRows` is the pure calculation: no DB access,
//     no network calls, fully deterministic and exhaustively unit-testable.
//     Its top-level imports are deliberately limited to other pure modules
//     (`seat-ledger.ts`, `identity-resolver.ts`, `periods.ts`) plus
//     *type-only* imports from `dashboard-config.ts`/`license-history-repo.ts`
//     (erased at compile time — see tsconfig's `isolatedModules`), so this
//     function stays testable even in environments where better-sqlite3's
//     native binding is unavailable (see `license-history-repo.test.ts`'s
//     compatibility-pattern comment).
//   - `persistMaterializedLicensePeriod` is the DB-side wrapper: it runs the
//     pure calculation, then replaces this enterprise+period's materialized
//     rows in one transaction via `replaceMaterializedPeriod` (which already
//     performs delete-then-plain-insert so a duplicate canonical key rolls
//     back the whole batch). It reaches `replaceMaterializedPeriod` via a
//     dynamic `import()` *inside* the function body (never at module top
//     level) so merely importing this module's pure exports never triggers
//     `better-sqlite3`'s native binding load.

import { UNATTRIBUTED_ORG, type SeatLedgerRow, type SeatLedgerConfidence } from "./seat-ledger";
import type { ResolvedIdentity } from "./identity-resolver";
import { cycleBoundsUtc } from "./periods";
import type { ResolvedLicensingConfig, LicensePlanKey } from "@/lib/config/dashboard-config";
import type { LicensePeriodRowInput } from "@/lib/db/license-history-repo";

export { UNATTRIBUTED_ORG };

// ── Consumption source precedence ────────────────────────────────────────

/**
 * Every AI-Credit consumption source this materializer can select from, in
 * strict precedence order (index 0 = highest precedence). See
 * {@link selectConsumptionSource}.
 *
 *   1. `csv_import`             — a configured CSV export for this period.
 *   2. `enterprise_api`         — the enterprise-wide per-user AIC API.
 *   3. `org_api`                — the per-org AIC API, but ONLY eligible when
 *      the enterprise endpoint was unavailable for the whole run (see
 *      {@link MaterializeLicensePeriodInput.enterpriseApiUnavailable}).
 *   4. `billing_report`         — synced `ai_credit` billing-report rows.
 *   5. `usage_metrics_fallback` — Usage Metrics API `ai_credits_used`, a
 *      current-period-only fallback, explicitly tagged as a different
 *      (lower-confidence) source rather than silently blended with 1-4.
 */
export type ConsumptionSourceKind =
  | "csv_import"
  | "enterprise_api"
  | "org_api"
  | "billing_report"
  | "usage_metrics_fallback";

export const CONSUMPTION_SOURCE_PRECEDENCE: ConsumptionSourceKind[] = [
  "csv_import",
  "enterprise_api",
  "org_api",
  "billing_report",
  "usage_metrics_fallback",
];

/**
 * A single raw consumption record from one source, prior to per-key
 * aggregation. Deliberately has no `netUsd` field: this materializer only
 * ever surfaces `grossUsd` as `aicConsumedUsd` (see `finalizeRow`'s callers
 * below) — net-of-discount consumption has no downstream semantic here. Net
 * USD *is* tracked (and persisted) one layer up, in the raw per-source
 * evidence rows written by `license-history-repo.ts`'s `upsertAicConsumption`
 * (`LicenseAicConsumptionInput.netUsd` → `license_aic_consumption.net_usd`)
 * — that's a distinct, audit-trail concern from this module's canonical
 * per-(org, holder) reconciliation row.
 */
export interface ConsumptionRecordInput {
  source: ConsumptionSourceKind;
  /** Org login attribution, or null/empty for an enterprise-only (unattributed) record. Never copied across a holder's other org seats — see module doc comment. */
  orgLogin?: string | null;
  holderKey: string;
  credits?: number;
  grossUsd?: number;
}

// ── Seat metadata side-channel ───────────────────────────────────────────
//
// `SeatLedgerRow` (Task 6) intentionally carries only assignment lifecycle
// fields (assignedAt/revokedAt/confidence) — plan type, assignment source,
// and last-activity are sourced from the seat/snapshot record itself. This
// side-channel lets a caller supply that metadata without requiring
// `seat-ledger.ts` (out of this task's scope) to grow new fields.

export interface SeatMetadata {
  /** Raw plan_type as observed by the seat source (e.g. `license_seat_snapshots.plan_type`). Normalized via {@link normalizePlanKey}. */
  planType?: string | null;
  /** Assignment source (e.g. "direct" | "team"), passed through from the seat source. Defaults to "direct" with a data-quality note when unavailable. */
  assignedVia?: string | null;
  /** Most recent activity timestamp for this seat, when known. */
  lastActivityAt?: string | null;
}

/** Build the canonical (orgLogin, holderKey) key used to key {@link MaterializeLicensePeriodInput.seatMetadata} and to join consumption records against seat rows. Exported so callers can build metadata/consumption maps consistently. */
export function licensePeriodCanonicalKey(orgLogin: string | null | undefined, holderKey: string): string {
  return `${normalizeOrg(orgLogin)}\u0000${holderKey}`;
}

// ── Input ─────────────────────────────────────────────────────────────────

export interface MaterializeLicensePeriodInput {
  /** The enterprise this call is scoped to. Every output row carries this same value. */
  enterpriseSlug: string;
  /** The single "YYYY-MM" period this call materializes. */
  billingPeriod: string;
  /** Seat ledger rows for this enterprise+period (see `buildSeatLedger`). Rows scoped to a different enterprise/period are dropped with a warning, never silently mixed in. */
  seatRows: SeatLedgerRow[];
  /** Resolved identity per holderKey (see `resolveIdentity`). A holder with no entry degrades to an "unresolved" identity derived from the seat row's observed login — never fabricated. */
  identities?: Record<string, ResolvedIdentity>;
  /** Plan type / assignment source / last-activity metadata, keyed by {@link licensePeriodCanonicalKey}. */
  seatMetadata?: Record<string, SeatMetadata>;
  /** Raw consumption records from every available source, prior to aggregation/selection. */
  consumption?: ConsumptionRecordInput[];
  /**
   * True when the enterprise-level per-user AIC API was unavailable for this
   * entire run (e.g. forbidden/unreachable) — the only condition under which
   * `org_api`-sourced consumption may be used at all (precedence tier 3).
   * Default false: `org_api` records are otherwise ignored even when present.
   */
  enterpriseApiUnavailable?: boolean;
  config: ResolvedLicensingConfig;
  /** ISO instant this materialization reflects data as-of. */
  asOfUtc: string;
  /** ISO instant this materialization was generated at. */
  generatedAtUtc: string;
}

// ── Output ────────────────────────────────────────────────────────────────

/** One materialized canonical (org, holder) row for the period, plus derived (non-persisted) cost/utilization insights. */
export interface MaterializedLicensePeriodRow {
  enterpriseSlug: string;
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  githubUserId: number | null;
  userLogin: string | null;
  resolvedUserLogin: string | null;
  externalIdentity: string | null;
  identityResolutionSource: string;
  accountState: string;
  licenseAssignedDate: string | null;
  userRevokedDate: string | null;
  planType: LicensePlanKey;
  seatStatus: string;
  assignedVia: string;
  lastActivityAt: string | null;
  licenseCost: number;
  defaultAicCredits: number;
  defaultAicUsd: number;
  aicAssignedUsd: number;
  aicAssignedRule: string;
  aicConsumedCredits: number;
  aicConsumedUsd: number;
  currency: string;
  rowSource: string;
  consumptionSource: string | null;
  historyConfidence: SeatLedgerConfidence;
  dataQualityNotes: string[];
  /** consumed / effective-budget × 100. Zero when there is no assigned or default budget (safe zero-budget semantics). */
  utilizationPct: number;
  /** max(consumedCredits - defaultAicCredits, 0) — never negative. */
  overageCredits: number;
  /** max(consumedUsd - effectiveBudgetUsd, 0) — never negative. */
  overageUsd: number;
  /** licenseCost + overageUsd. Does NOT double-count gross consumption already covered by the included allowance. */
  totalCost: number;
  asOfUtc: string;
  generatedAtUtc: string;
}

export interface MaterializeLicensePeriodResult {
  rows: MaterializedLicensePeriodRow[];
  /** Ledger-wide warnings not tied to a single canonical row (scope mismatches, duplicate seat rows, etc.). */
  warnings: string[];
}

// ── Plan normalization (mirrors `license-repo.ts`'s `normalizePlan`) ──────
//
// Reimplemented locally (rather than imported) so this module's pure
// calculation stays import-free of the DB layer at the type level too —
// `license-repo.ts` imports `getDb` at module top level. Keep in sync with
// `license-repo.ts`'s `normalizePlan` by design; covered by parity tests.

const PLAN_ALIASES: Record<string, LicensePlanKey> = {
  business: "business",
  copilot_business: "business",
  "copilot business": "business",
  enterprise: "enterprise",
  copilot_enterprise: "enterprise",
  "copilot enterprise": "enterprise",
};

/** Normalize a raw plan_type string to a canonical {@link LicensePlanKey}. Unknown/missing values normalize to "unknown" — they never silently fall through to a paid plan's price or allowance. */
export function normalizePlanKey(planType: string | null | undefined): LicensePlanKey {
  const normalized = (planType ?? "").trim().toLowerCase();
  return PLAN_ALIASES[normalized] ?? "unknown";
}

// ── Small pure helpers ────────────────────────────────────────────────────

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeOrg(orgLogin: string | null | undefined): string {
  const trimmed = (orgLogin ?? "").trim();
  return trimmed.length > 0 ? trimmed : UNATTRIBUTED_ORG;
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function normalizeEnterpriseSlug(enterpriseSlug: string): string {
  const trimmed = (enterpriseSlug ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error(`materializeLicensePeriodRows: enterpriseSlug must be a non-empty string, got ${JSON.stringify(enterpriseSlug)}`);
  }
  return trimmed;
}

function splitCanonicalKey(key: string): [string, string] {
  const idx = key.indexOf("\u0000");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function defaultIdentityFromSeat(seatRow: SeatLedgerRow): ResolvedIdentity {
  return {
    holderKey: seatRow.holderKey,
    githubUserId: seatRow.githubUserId,
    userLogin: seatRow.observedLogin,
    resolvedUserLogin: seatRow.observedLogin,
    externalIdentity: null,
    source: "unresolved",
    accountState: "unknown",
    notes: ["identity not resolved for this holder; falling back to observed seat login"],
  };
}

function defaultIdentityForHolder(holderKey: string): ResolvedIdentity {
  return {
    holderKey,
    githubUserId: null,
    userLogin: null,
    resolvedUserLogin: null,
    externalIdentity: null,
    source: "unresolved",
    accountState: "unknown",
    notes: ["identity not resolved for this holder"],
  };
}

// ── Allowance selection (dated window, then static fallback) ────────────

/**
 * Resolve the monthly AI-credit allowance (credits) for a normalized plan in
 * a given "YYYY-MM" billing period: a matching dated allowance window takes
 * precedence over the static `aicAllowance` default. Same-plan windows are
 * already validated non-overlapping by `getLicensingConfig`, so the first
 * match is the only match by construction.
 *
 * An unknown plan always resolves through `aicAllowance.unknown` (typically
 * 0) — it can never match a dated window keyed to a *different*,
 * recognized plan.
 */
function resolveAllowanceCredits(period: string, plan: LicensePlanKey, config: ResolvedLicensingConfig): number {
  const periodStartDate = `${period}-01`;
  for (const window of config.datedAllowances) {
    const credits = window.credits[plan];
    if (credits === undefined) continue;
    if (periodStartDate < window.start) continue;
    if (window.end && periodStartDate > window.end) continue;
    return credits;
  }
  return config.aicAllowance[plan] ?? config.aicAllowance.unknown ?? 0;
}

// ── Consumption aggregation + source selection ───────────────────────────

interface AggregatedConsumption {
  credits: number;
  grossUsd: number;
}

/**
 * Aggregate raw consumption records by (canonical org/holder key, source):
 * duplicate rows within the SAME source at the SAME canonical grain are
 * summed; different sources for the same canonical key are kept separate
 * (never summed across sources) so {@link selectConsumptionSource} can apply
 * precedence afterward.
 */
function aggregateConsumption(records: ConsumptionRecordInput[]): Map<string, Map<ConsumptionSourceKind, AggregatedConsumption>> {
  const byKey = new Map<string, Map<ConsumptionSourceKind, AggregatedConsumption>>();
  for (const record of records) {
    const key = licensePeriodCanonicalKey(record.orgLogin, record.holderKey);
    let bySource = byKey.get(key);
    if (!bySource) {
      bySource = new Map();
      byKey.set(key, bySource);
    }
    const credits = record.credits ?? 0;
    const grossUsd = record.grossUsd ?? 0;
    const existing = bySource.get(record.source);
    if (existing) {
      existing.credits += credits;
      existing.grossUsd += grossUsd;
    } else {
      bySource.set(record.source, { credits, grossUsd });
    }
  }
  return byKey;
}

/**
 * Select exactly one consumption source for a canonical key, following
 * {@link CONSUMPTION_SOURCE_PRECEDENCE}. `org_api` is skipped entirely
 * unless `enterpriseApiUnavailable` is true, regardless of whether a
 * record for it exists — competing sources are never summed.
 */
function selectConsumptionSource(
  bySource: Map<ConsumptionSourceKind, AggregatedConsumption>,
  enterpriseApiUnavailable: boolean
): [ConsumptionSourceKind, AggregatedConsumption] | null {
  for (const source of CONSUMPTION_SOURCE_PRECEDENCE) {
    if (source === "org_api" && !enterpriseApiUnavailable) continue;
    const agg = bySource.get(source);
    if (agg) return [source, agg];
  }
  return null;
}

// ── Row builder (internal working shape, pre-derived-fields) ────────────

type RowBuilder = Omit<
  MaterializedLicensePeriodRow,
  "enterpriseSlug" | "billingPeriod" | "utilizationPct" | "overageCredits" | "overageUsd" | "totalCost" | "asOfUtc" | "generatedAtUtc"
>;

function finalizeRow(
  builder: RowBuilder,
  enterpriseSlug: string,
  billingPeriod: string,
  asOfUtc: string,
  generatedAtUtc: string
): MaterializedLicensePeriodRow {
  const effectiveBudgetUsd = builder.aicAssignedUsd > 0 ? builder.aicAssignedUsd : builder.defaultAicUsd > 0 ? builder.defaultAicUsd : 0;
  const utilizationPct = effectiveBudgetUsd > 0 ? round2((builder.aicConsumedUsd / effectiveBudgetUsd) * 100) : 0;
  const overageUsd = Math.max(round2(builder.aicConsumedUsd - effectiveBudgetUsd), 0);
  const overageCredits = Math.max(round2(builder.aicConsumedCredits - builder.defaultAicCredits), 0);
  const totalCost = round2(builder.licenseCost + overageUsd);

  return {
    ...builder,
    enterpriseSlug,
    billingPeriod,
    utilizationPct,
    overageCredits,
    overageUsd,
    totalCost,
    asOfUtc,
    generatedAtUtc,
  };
}

// ── Pure calculation ──────────────────────────────────────────────────────

/**
 * Materialize exactly one enterprise's exactly one "YYYY-MM" billing period
 * into the canonical (orgLogin, holderKey) reconciliation grain. Pure and
 * side-effect free — see module doc comment.
 */
export function materializeLicensePeriodRows(input: MaterializeLicensePeriodInput): MaterializeLicensePeriodResult {
  const enterpriseSlug = normalizeEnterpriseSlug(input.enterpriseSlug);
  const billingPeriod = input.billingPeriod;
  const periodEndMs = Date.parse(cycleBoundsUtc(billingPeriod).end); // throws on a malformed period

  const config = input.config;
  const identities = input.identities ?? {};
  const seatMetadata = input.seatMetadata ?? {};
  const warnings: string[] = [];
  const builders = new Map<string, RowBuilder>();

  for (const seatRow of input.seatRows) {
    if (seatRow.enterpriseSlug !== enterpriseSlug || seatRow.billingPeriod !== billingPeriod) {
      warnings.push(
        `Dropped seat ledger row scoped to (enterpriseSlug=${seatRow.enterpriseSlug}, billingPeriod=${seatRow.billingPeriod}) — this call is scoped to (${enterpriseSlug}, ${billingPeriod}).`
      );
      continue;
    }

    const orgLogin = normalizeOrg(seatRow.orgLogin);
    const key = licensePeriodCanonicalKey(orgLogin, seatRow.holderKey);
    if (builders.has(key)) {
      warnings.push(`Duplicate seat ledger row for (org=${orgLogin}, holder=${seatRow.holderKey}) in period ${billingPeriod} — keeping the first and ignoring the rest.`);
      continue;
    }

    const identity = identities[seatRow.holderKey] ?? defaultIdentityFromSeat(seatRow);
    const metadata = seatMetadata[key] ?? {};
    const notes = [...identity.notes];

    const rawPlanType = metadata.planType ?? null;
    const planType = normalizePlanKey(rawPlanType);
    if (rawPlanType == null) {
      notes.push("seat plan_type unavailable; defaulting to unknown");
    } else if (planType === "unknown" && rawPlanType.trim() !== "") {
      notes.push(`seat plan_type "${rawPlanType}" did not normalize to a known plan; treated as unknown`);
    }

    const trimmedAssignedVia = metadata.assignedVia?.trim();
    const assignedVia = trimmedAssignedVia || "direct";
    if (!trimmedAssignedVia) {
      notes.push("assigned_via unavailable; defaulting to direct");
    }

    const revokedAt = seatRow.revokedAt;
    const seatStatus = revokedAt != null && Date.parse(revokedAt) < periodEndMs ? "inactive" : "active";

    const licenseCost = round2(config.licenseCost[planType] ?? config.licenseCost.unknown ?? 0);
    const defaultAicCredits = resolveAllowanceCredits(billingPeriod, planType, config);
    const defaultAicUsd = round2(defaultAicCredits * config.creditToUsd);

    const loginForBudget = (identity.resolvedUserLogin ?? seatRow.holderKey).toLowerCase();
    const perUserBudget = config.perUserBudgetUsd[loginForBudget];
    const hasBudget = typeof perUserBudget === "number";
    const aicAssignedUsd = round2(hasBudget ? perUserBudget : defaultAicUsd);
    const aicAssignedRule = hasBudget ? "per_user_budget" : "plan_default";

    builders.set(key, {
      orgLogin,
      holderKey: seatRow.holderKey,
      githubUserId: identity.githubUserId,
      userLogin: identity.userLogin,
      resolvedUserLogin: identity.resolvedUserLogin,
      externalIdentity: identity.externalIdentity,
      identityResolutionSource: identity.source,
      accountState: identity.accountState,
      licenseAssignedDate: dateOnly(seatRow.assignedAt),
      userRevokedDate: dateOnly(revokedAt),
      planType,
      seatStatus,
      assignedVia,
      lastActivityAt: metadata.lastActivityAt ?? null,
      licenseCost,
      defaultAicCredits,
      defaultAicUsd,
      aicAssignedUsd,
      aicAssignedRule,
      aicConsumedCredits: 0,
      aicConsumedUsd: 0,
      currency: config.currency,
      rowSource: "seat_ledger",
      consumptionSource: null,
      historyConfidence: seatRow.confidence,
      dataQualityNotes: notes,
    });
  }

  // ── Join consumption: aggregate per (canonical key, source), then select
  // exactly one source per canonical key. Enterprise-only (unattributed)
  // consumption joins to a single (UNATTRIBUTED_ORG, holder) row — it is
  // never copied across a holder's other org seat rows.
  const aggregated = aggregateConsumption(input.consumption ?? []);
  for (const [key, bySource] of aggregated) {
    const chosen = selectConsumptionSource(bySource, input.enterpriseApiUnavailable ?? false);
    if (!chosen) continue;
    const [source, agg] = chosen;

    let builder = builders.get(key);
    if (!builder) {
      const [orgLogin, holderKey] = splitCanonicalKey(key);
      const identity = identities[holderKey] ?? defaultIdentityForHolder(holderKey);
      const notes = [...identity.notes, "consumption recorded with no matching seat assignment for this period"];
      if (orgLogin === UNATTRIBUTED_ORG) {
        notes.push("enterprise-only AI-Credit consumption; not attributed to any organization");
      }

      const loginForBudget = (identity.resolvedUserLogin ?? holderKey).toLowerCase();
      const perUserBudget = config.perUserBudgetUsd[loginForBudget];
      const hasBudget = typeof perUserBudget === "number";

      builder = {
        orgLogin,
        holderKey,
        githubUserId: identity.githubUserId,
        userLogin: identity.userLogin,
        resolvedUserLogin: identity.resolvedUserLogin,
        externalIdentity: identity.externalIdentity,
        identityResolutionSource: identity.source,
        accountState: identity.accountState,
        licenseAssignedDate: null,
        userRevokedDate: null,
        planType: "unknown",
        seatStatus: "no_seat",
        assignedVia: "unknown",
        lastActivityAt: null,
        licenseCost: 0,
        defaultAicCredits: 0,
        defaultAicUsd: 0,
        aicAssignedUsd: hasBudget ? round2(perUserBudget as number) : 0,
        aicAssignedRule: hasBudget ? "per_user_budget" : "plan_default",
        aicConsumedCredits: 0,
        aicConsumedUsd: 0,
        currency: config.currency,
        rowSource: "consumption_only",
        consumptionSource: null,
        historyConfidence: "unrecoverable",
        dataQualityNotes: notes,
      };
      builders.set(key, builder);
    }

    builder.aicConsumedCredits = round2(agg.credits);
    builder.aicConsumedUsd = round2(agg.grossUsd);
    builder.consumptionSource = source;
  }

  const rows = [...builders.values()]
    .map((builder) => finalizeRow(builder, enterpriseSlug, billingPeriod, input.asOfUtc, input.generatedAtUtc))
    .sort((a, b) => a.orgLogin.localeCompare(b.orgLogin) || a.holderKey.localeCompare(b.holderKey));

  return { rows, warnings };
}

// ── Persistence (DB-touching) ─────────────────────────────────────────────

/** Map a materialized row down to exactly the columns `replaceMaterializedPeriod` persists (dropping the derived-only utilization/overage/total-cost fields, which are recomputed at query time from the persisted columns — see `license-history-repo.ts`). */
function toLicensePeriodRowInput(row: MaterializedLicensePeriodRow): LicensePeriodRowInput {
  return {
    orgLogin: row.orgLogin,
    holderKey: row.holderKey,
    githubUserId: row.githubUserId,
    userLogin: row.userLogin,
    resolvedUserLogin: row.resolvedUserLogin,
    externalIdentity: row.externalIdentity,
    identityResolutionSource: row.identityResolutionSource,
    accountState: row.accountState,
    licenseAssignedDate: row.licenseAssignedDate,
    userRevokedDate: row.userRevokedDate,
    planType: row.planType,
    seatStatus: row.seatStatus,
    assignedVia: row.assignedVia,
    lastActivityAt: row.lastActivityAt,
    licenseCost: row.licenseCost,
    defaultAicCredits: row.defaultAicCredits,
    defaultAicUsd: row.defaultAicUsd,
    aicAssignedUsd: row.aicAssignedUsd,
    aicAssignedRule: row.aicAssignedRule,
    aicConsumedCredits: row.aicConsumedCredits,
    aicConsumedUsd: row.aicConsumedUsd,
    currency: row.currency,
    rowSource: row.rowSource,
    consumptionSource: row.consumptionSource,
    historyConfidence: row.historyConfidence,
    dataQualityNotes: row.dataQualityNotes,
    asOfUtc: row.asOfUtc,
    generatedAtUtc: row.generatedAtUtc,
  };
}

export interface PersistMaterializedLicensePeriodResult {
  rows: MaterializedLicensePeriodRow[];
  warnings: string[];
  /** Number of rows written by `replaceMaterializedPeriod`. */
  written: number;
}

/**
 * Compute {@link materializeLicensePeriodRows} for one enterprise+period and
 * persist the result via `replaceMaterializedPeriod` — a single delete-then-
 * insert transaction, so a duplicate canonical key in the computed batch
 * rolls back the whole write rather than silently replacing stale data.
 *
 * `replaceMaterializedPeriod` is reached via a dynamic `import()` so this
 * module's top-level import graph never depends on the DB layer — see the
 * module doc comment.
 */
export async function persistMaterializedLicensePeriod(
  input: MaterializeLicensePeriodInput
): Promise<PersistMaterializedLicensePeriodResult> {
  const result = materializeLicensePeriodRows(input);
  const { replaceMaterializedPeriod } = await import("@/lib/db/license-history-repo");
  const mapped = result.rows.map(toLicensePeriodRowInput);
  const written = replaceMaterializedPeriod(input.enterpriseSlug, input.billingPeriod, mapped);
  return { ...result, written };
}


