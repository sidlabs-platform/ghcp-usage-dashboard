// License & AI Credits reconciliation repository.
//
// Reproduces the copilot-aic-report per-user license + AI-credit reconciliation
// entirely from data already synced by the dashboard:
//   - copilot_seats            → license lifecycle (assigned date, plan, team, status, activity)
//   - billing_premium_requests → per-user AI-credit consumption (aic_quantity, aic_gross_amount)
// plus configured pricing / allowances (getLicensingConfig). No re-sync required;
// degrades gracefully to empty/zero results when the underlying tables are empty.

import { getDb } from "./database";
import { getAttributedCreditConsumptionByUser } from "./billing-repo";
import { getLicensingConfig } from "@/lib/config/dashboard-config";
import type { ResolvedLicensingConfig, LicensePlanKey } from "@/lib/config/dashboard-config";
import type {
  LicenseReconciliationRow,
  LicenseReconciliationKPIs,
  LicenseGroupBreakdown,
  UtilizationBucket,
  ActivityStatus,
} from "@/lib/types/licensing";
import { SEAT_ACTIVE_WINDOW_DAYS as ACTIVE_WINDOW_DAYS } from "@/lib/constants";

export interface LicenseReconciliationFilters {
  /** Restrict to these logins (resolved from team/org scope). */
  allowedLogins?: Set<string>;
  /** Restrict to these enterprise slugs. */
  enterpriseSlugs?: string[];
  /** Restrict billing rows to these org slugs (the scope filter's org selection). */
  scopeOrgs?: string[];
  /** Case-insensitive substring match on user_login / org. */
  search?: string;
}

export interface LicenseReconciliationOptions {
  /** Start date (YYYY-MM-DD) of the consumption window. */
  start: string;
  /** End date (YYYY-MM-DD) of the consumption window. */
  end: string;
  filters?: LicenseReconciliationFilters;
}

/** Normalize a raw plan_type to a canonical key. */
export function normalizePlan(planType: string | null | undefined): LicensePlanKey {
  const p = (planType ?? "").trim().toLowerCase();
  if (p === "business" || p === "copilot_business" || p === "copilot business") return "business";
  if (p === "enterprise" || p === "copilot_enterprise" || p === "copilot enterprise") return "enterprise";
  return "unknown";
}

/** Plan precedence when a user holds seats of different plans: enterprise > business > unknown. */
function planRank(plan: LicensePlanKey): number {
  return plan === "enterprise" ? 2 : plan === "business" ? 1 : 0;
}

interface SeatRow {
  org_slug: string;
  user_login: string;
  plan_type: string | null;
  last_activity_at: string | null;
  assigning_team_slug: string | null;
  pending_cancellation_date: string | null;
  created_at: string | null;
}

function buildEnterpriseFilter(
  slugs: string[] | undefined,
  prefix: string,
): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` ${prefix} enterprise_slug IN (${placeholders})`, params: slugs };
}

function toDateOnly(value: string | null): string | null {
  if (!value) return null;
  return value.length >= 10 ? value.slice(0, 10) : value;
}

/**
 * Classify a seat's activity relative to a reference instant.
 *
 * `now` must be the end of the window being reported, not wall-clock now —
 * otherwise a historical view labels seats using a window that has nothing to
 * do with the period on screen.
 */
function deriveActivityStatus(lastActivity: string | null, now: Date): ActivityStatus {
  if (!lastActivity) return "never";
  const ts = Date.parse(lastActivity);
  if (Number.isNaN(ts)) return "never";
  const cutoff = now.getTime() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return ts >= cutoff ? "active_30d" : "inactive_30d";
}

/**
 * Per-user AI-credit consumption for the window, read through the shared
 * billing query so this page's per-user total is the same number its cost-basis
 * strip reports as "attributed". Returns an empty result (never throws) when
 * billing was never synced.
 */
function getConsumptionByUser(
  start: string,
  end: string,
  filters?: LicenseReconciliationFilters,
): ReturnType<typeof getAttributedCreditConsumptionByUser> {
  const db = getDb();
  const empty = { byLogin: new Map<string, { credits: number; usd: number }>(), totalCredits: 0, totalUsd: 0, unattributedCredits: 0 };

  // billing_premium_requests may not exist if billing was never synced.
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_premium_requests'")
    .get();
  if (!exists) return empty;

  return getAttributedCreditConsumptionByUser(
    start,
    end,
    {
      // Identical scoping to `getCopilotCostBasis`, so the per-user total this
      // returns is the same "attributed" figure the cost-basis strip shows.
      allowedLogins: filters?.allowedLogins ? [...filters.allowedLogins] : undefined,
      scopeOrgs: filters?.scopeOrgs?.length ? filters.scopeOrgs : undefined,
    },
    filters?.enterpriseSlugs,
  );
}

/** How much of the window's attributed AI-credit consumption landed on a seat row. */
export interface LicenseConsumptionCoverage {
  /** Total attributed to a login in scope — equals `CopilotCostBasis.creditsAttributed`. */
  attributedCredits: number;
  attributedUsd: number;
  /** The part that joined onto an emitted (seat-holding, filter-matching) row. */
  matchedCredits: number;
  matchedUsd: number;
  /** The remainder: consumption by logins with no seat in scope, or excluded by the active filters. */
  unmatchedCredits: number;
  unmatchedUsd: number;
  unmatchedUsers: number;
}

/** The live-snapshot reconciliation dataset plus the consumption residual it could not place on a row. */
export interface LicenseReconciliationDataset {
  rows: LicenseReconciliationRow[];
  coverage: LicenseConsumptionCoverage;
}

/**
 * Build the full per-user reconciliation dataset (unpaginated). Seats are the
 * driver, so the result set is bounded by the number of licensed users.
 *
 * Consumption that cannot be placed on a seat row is not discarded — it is
 * returned as `coverage`, so callers can state the difference between what the
 * per-user table shows and what was actually billed instead of quietly
 * reporting a smaller number.
 */
export function getLicenseReconciliationDataset(
  opts: LicenseReconciliationOptions,
): LicenseReconciliationDataset {
  const db = getDb();
  const cfg: ResolvedLicensingConfig = getLicensingConfig();
  const { start, end, filters } = opts;

  const emptyCoverage: LicenseConsumptionCoverage = {
    attributedCredits: 0,
    attributedUsd: 0,
    matchedCredits: 0,
    matchedUsd: 0,
    unmatchedCredits: 0,
    unmatchedUsd: 0,
    unmatchedUsers: 0,
  };

  const seatsTableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='copilot_seats'")
    .get();
  if (!seatsTableExists) return { rows: [], coverage: emptyCoverage };

  const ent = buildEnterpriseFilter(filters?.enterpriseSlugs, "WHERE");
  const seats = db
    .prepare(
      `SELECT org_slug, user_login, plan_type, last_activity_at,
              assigning_team_slug, pending_cancellation_date, created_at
       FROM copilot_seats${ent.clause}`,
    )
    .all(...ent.params) as SeatRow[];

  const consumption = getConsumptionByUser(start, end, filters);
  // Anchored to the end of the *selected* window, not wall-clock now. Using
  // `new Date()` asked "was this seat active in the 30 days before today?"
  // while every other figure on the page described the selected period, so a
  // historical window mixed two different definitions of "active" in one table.
  // Falls back to now when the window end is unparseable or in the future.
  const windowEnd = Date.parse(`${end}T23:59:59.999Z`);
  const now = Number.isNaN(windowEnd) ? new Date() : new Date(Math.min(windowEnd, Date.now()));

  // Group seats by user_login.
  interface Acc {
    login: string;
    orgs: Set<string>;
    seatCount: number;
    /** Seats with no pending cancellation. Counted per seat, not per user: a user can hold one active and one cancelling seat. */
    activeSeatCount: number;
    plan: LicensePlanKey;
    assignedDate: string | null;
    lastActivity: string | null;
    hasTeam: boolean;
    hasDirect: boolean;
    anyActive: boolean;
    revokedDate: string | null;
    licenseCost: number;
    orgLicenseCost: Map<string, number>;
    orgSeatCount: Map<string, number>;
  }
  const byUser = new Map<string, Acc>();

  for (const s of seats) {
    if (!s.user_login) continue;
    const key = s.user_login;
    let acc = byUser.get(key);
    if (!acc) {
      acc = {
        login: s.user_login,
        orgs: new Set<string>(),
        seatCount: 0,
        activeSeatCount: 0,
        plan: "unknown",
        assignedDate: null,
        lastActivity: null,
        hasTeam: false,
        hasDirect: false,
        anyActive: false,
        revokedDate: null,
        licenseCost: 0,
        orgLicenseCost: new Map<string, number>(),
        orgSeatCount: new Map<string, number>(),
      };
      byUser.set(key, acc);
    }

    const plan = normalizePlan(s.plan_type);
    if (planRank(plan) > planRank(acc.plan)) acc.plan = plan;
    if (s.org_slug) acc.orgs.add(s.org_slug);
    acc.seatCount += 1;
    const seatLicenseCost = cfg.licenseCost[plan] ?? cfg.licenseCost.unknown ?? 0;
    acc.licenseCost += seatLicenseCost;
    if (s.org_slug) {
      acc.orgLicenseCost.set(s.org_slug, (acc.orgLicenseCost.get(s.org_slug) ?? 0) + seatLicenseCost);
      acc.orgSeatCount.set(s.org_slug, (acc.orgSeatCount.get(s.org_slug) ?? 0) + 1);
    }

    const assigned = toDateOnly(s.created_at);
    if (assigned && (!acc.assignedDate || assigned < acc.assignedDate)) acc.assignedDate = assigned;

    if (s.last_activity_at && (!acc.lastActivity || s.last_activity_at > acc.lastActivity)) {
      acc.lastActivity = s.last_activity_at;
    }

    if (s.assigning_team_slug) acc.hasTeam = true;
    else acc.hasDirect = true;

    if (s.pending_cancellation_date) {
      const rev = toDateOnly(s.pending_cancellation_date);
      if (rev && (!acc.revokedDate || rev > acc.revokedDate)) acc.revokedDate = rev;
    } else {
      acc.anyActive = true;
      acc.activeSeatCount += 1;
    }
  }

  const searchLower = filters?.search?.trim().toLowerCase();
  const allowedLoginKeys = filters?.allowedLogins
    ? new Set(Array.from(filters.allowedLogins, (login) => login.toLowerCase()))
    : undefined;
  const rows: LicenseReconciliationRow[] = [];
  const matchedLogins = new Set<string>();

  for (const acc of byUser.values()) {
    if (allowedLoginKeys && !allowedLoginKeys.has(acc.login.toLowerCase())) continue;

    if (searchLower) {
      const inLogin = acc.login.toLowerCase().includes(searchLower);
      const inOrg = [...acc.orgs].some((o) => o.toLowerCase().includes(searchLower));
      if (!inLogin && !inOrg) continue;
    }

    const loginKey = acc.login.toLowerCase();
    const consumed = consumption.byLogin.get(loginKey) ?? { credits: 0, usd: 0 };
    if (consumption.byLogin.has(loginKey)) matchedLogins.add(loginKey);
    const defaultCredits = cfg.aicAllowance[acc.plan] ?? cfg.aicAllowance.unknown ?? 0;
    const defaultUsd = defaultCredits * cfg.creditToUsd;

    const budget = cfg.perUserBudgetUsd[acc.login.toLowerCase()];
    const hasBudget = typeof budget === "number";
    const assignedUsd = hasBudget ? budget : defaultUsd;

    const utilization = defaultCredits > 0 ? (consumed.credits / defaultCredits) * 100 : 0;
    const overBudget = assignedUsd > 0 ? consumed.usd > assignedUsd : consumed.usd > 0;

    // A user is active if at least one seat is not pending cancellation.
    const userStatus: "active" | "inactive" = acc.anyActive ? "active" : "inactive";
    const orgLicenseCosts = Object.fromEntries(
      [...acc.orgLicenseCost.entries()].map(([org, cost]) => [org, round2(cost)]),
    );
    const orgSeatCounts = Object.fromEntries(acc.orgSeatCount.entries());

    const assignedVia = acc.hasDirect
      ? "direct"
      : acc.hasTeam
        ? "team"
        : "direct";

    rows.push({
      user_login: acc.login,
      orgs: [...acc.orgs].sort(),
      org_count: acc.orgs.size,
      seat_count: acc.seatCount,
      active_seat_count: acc.activeSeatCount,
      plan_type: acc.plan,
      license_assigned_date: acc.assignedDate,
      last_activity_at: acc.lastActivity,
      activity_status: deriveActivityStatus(acc.lastActivity, now),
      assigned_via: assignedVia,
      user_status: userStatus,
      seat_status: acc.revokedDate ? "pending_cancellation" : "active",
      user_revoked_date: acc.revokedDate,
      license_cost: round2(acc.licenseCost),
      org_license_costs: orgLicenseCosts,
      org_seat_counts: orgSeatCounts,
      default_aic_credits: defaultCredits,
      default_aic_usd: round2(defaultUsd),
      aic_assigned_usd: round2(assignedUsd),
      aic_assigned_rule: hasBudget ? "per_user_budget" : "plan_default",
      aic_consumed_credits: round2(consumed.credits),
      aic_consumed_usd: round2(consumed.usd),
      utilization_pct: round2(utilization),
      over_budget: overBudget,
      total_cost: round2(acc.licenseCost + consumed.usd),
    });
  }

  let matchedCredits = 0;
  let matchedUsd = 0;
  for (const login of matchedLogins) {
    const c = consumption.byLogin.get(login)!;
    matchedCredits += c.credits;
    matchedUsd += c.usd;
  }

  return {
    rows,
    coverage: {
      attributedCredits: round2(consumption.totalCredits),
      attributedUsd: round2(consumption.totalUsd),
      matchedCredits: round2(matchedCredits),
      matchedUsd: round2(matchedUsd),
      unmatchedCredits: round2(Math.max(consumption.totalCredits - matchedCredits, 0)),
      unmatchedUsd: round2(Math.max(consumption.totalUsd - matchedUsd, 0)),
      unmatchedUsers: consumption.byLogin.size - matchedLogins.size,
    },
  };
}

/**
 * Backward-compatible view of {@link getLicenseReconciliationDataset} that
 * returns only the rows.
 */
export function getLicenseReconciliationRows(
  opts: LicenseReconciliationOptions,
): LicenseReconciliationRow[] {
  return getLicenseReconciliationDataset(opts).rows;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Compute headline KPIs from a reconciliation dataset. */
export function computeLicenseKPIs(
  rows: LicenseReconciliationRow[],
  coverage?: LicenseConsumptionCoverage,
): LicenseReconciliationKPIs {
  const cfg = getLicensingConfig();
  let totalSeats = 0;
  let activeSeats = 0;
  let activeUsers = 0;
  let pendingCancellation = 0;
  let inactive30d = 0;
  let zeroConsumptionSeats = 0;
  let totalLicenseCost = 0;
  let totalAllowanceCredits = 0;
  let totalAssignedUsd = 0;
  let totalConsumedCredits = 0;
  let totalConsumedUsd = 0;
  let overBudgetUsers = 0;

  for (const r of rows) {
    totalSeats += r.seat_count;
    activeSeats += r.active_seat_count;
    if (r.user_status === "active") activeUsers += 1;
    if (r.seat_status === "pending_cancellation") pendingCancellation += 1;
    if (r.activity_status !== "active_30d") inactive30d += 1;
    if (r.aic_consumed_credits <= 0) zeroConsumptionSeats += r.seat_count;
    totalLicenseCost += r.license_cost;
    totalAllowanceCredits += r.default_aic_credits;
    totalAssignedUsd += r.aic_assigned_usd;
    totalConsumedCredits += r.aic_consumed_credits;
    totalConsumedUsd += r.aic_consumed_usd;
    if (r.over_budget) overBudgetUsers += 1;
  }

  const overallUtilization =
    totalAllowanceCredits > 0 ? (totalConsumedCredits / totalAllowanceCredits) * 100 : 0;

  return {
    totalUsers: rows.length,
    totalSeats,
    activeSeats,
    activeUsers,
    pendingCancellation,
    inactive30d,
    zeroConsumptionSeats,
    totalLicenseCost: round2(totalLicenseCost),
    totalAllowanceCredits: round2(totalAllowanceCredits),
    totalAssignedUsd: round2(totalAssignedUsd),
    totalConsumedCredits: round2(totalConsumedCredits),
    totalConsumedUsd: round2(totalConsumedUsd),
    overallUtilizationPct: round2(overallUtilization),
    overBudgetUsers,
    totalCostOfOwnership: round2(totalLicenseCost + totalConsumedUsd),
    currency: cfg.currency,
    unmatchedConsumedCredits: round2(coverage?.unmatchedCredits ?? 0),
    unmatchedConsumedUsd: round2(coverage?.unmatchedUsd ?? 0),
    unmatchedUsers: coverage?.unmatchedUsers ?? 0,
    dataSource: "live_snapshot_only",
  };
}

/** Group breakdown by plan type. */
export function computePlanBreakdown(
  rows: LicenseReconciliationRow[],
): LicenseGroupBreakdown[] {
  return groupBreakdown(rows, (r) => r.plan_type);
}

/** Group breakdown by organization (a multi-org user contributes seats to each org). */
export function computeOrgBreakdown(
  rows: LicenseReconciliationRow[],
): LicenseGroupBreakdown[] {
  const map = new Map<string, LicenseGroupBreakdown>();
  for (const r of rows) {
    const orgs = r.orgs.length > 0 ? r.orgs : ["(none)"];
    // License cost is seat-level per org when available. Allowance and
    // consumption are per-user; attribute them to the user's first org only so
    // org totals do not double-count a multi-org user's credits.
    orgs.forEach((org, idx) => {
      const g = ensureGroup(map, org);
      g.seats += r.org_seat_counts?.[org] ?? 1;
      g.licenseCost += r.org_license_costs?.[org] ?? r.license_cost / orgs.length;
      if (idx === 0) {
        g.allowanceCredits += r.default_aic_credits;
        g.consumedCredits += r.aic_consumed_credits;
        g.consumedUsd += r.aic_consumed_usd;
      }
    });
  }
  return finalizeGroups(map);
}

function groupBreakdown(
  rows: LicenseReconciliationRow[],
  keyFn: (r: LicenseReconciliationRow) => string,
): LicenseGroupBreakdown[] {
  const map = new Map<string, LicenseGroupBreakdown>();
  for (const r of rows) {
    const g = ensureGroup(map, keyFn(r));
    g.seats += r.seat_count;
    g.licenseCost += r.license_cost;
    g.allowanceCredits += r.default_aic_credits;
    g.consumedCredits += r.aic_consumed_credits;
    g.consumedUsd += r.aic_consumed_usd;
  }
  return finalizeGroups(map);
}

function ensureGroup(
  map: Map<string, LicenseGroupBreakdown>,
  key: string,
): LicenseGroupBreakdown {
  let g = map.get(key);
  if (!g) {
    g = {
      key,
      seats: 0,
      licenseCost: 0,
      allowanceCredits: 0,
      consumedCredits: 0,
      consumedUsd: 0,
      utilizationPct: 0,
    };
    map.set(key, g);
  }
  return g;
}

function finalizeGroups(map: Map<string, LicenseGroupBreakdown>): LicenseGroupBreakdown[] {
  const out = [...map.values()].map((g) => ({
    ...g,
    licenseCost: round2(g.licenseCost),
    allowanceCredits: round2(g.allowanceCredits),
    consumedCredits: round2(g.consumedCredits),
    consumedUsd: round2(g.consumedUsd),
    utilizationPct:
      g.allowanceCredits > 0 ? round2((g.consumedCredits / g.allowanceCredits) * 100) : 0,
  }));
  out.sort((a, b) => b.consumedCredits - a.consumedCredits || b.seats - a.seats);
  return out;
}

const UTILIZATION_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0%", min: 0, max: 0 },
  { label: "1–25%", min: 0.0001, max: 25 },
  { label: "26–50%", min: 25, max: 50 },
  { label: "51–75%", min: 50, max: 75 },
  { label: "76–100%", min: 75, max: 100 },
  { label: ">100%", min: 100, max: Infinity },
];

/** Bucket users into a utilization histogram. */
export function computeUtilizationBuckets(
  rows: LicenseReconciliationRow[],
): UtilizationBucket[] {
  return UTILIZATION_BUCKETS.map((b) => {
    const count = rows.filter((r) => {
      const u = r.utilization_pct;
      if (b.label === "0%") return u <= 0;
      if (b.label === ">100%") return u > 100;
      return u > b.min && u <= b.max;
    }).length;
    return { label: b.label, min: b.min, max: b.max, count };
  });
}

export type LicenseSortField =
  | "user_login"
  | "plan_type"
  | "license_assigned_date"
  | "last_activity_at"
  | "license_cost"
  | "aic_consumed_credits"
  | "aic_consumed_usd"
  | "utilization_pct"
  | "total_cost";

/** Sort reconciliation rows in place by a field. */
export function sortLicenseRows(
  rows: LicenseReconciliationRow[],
  field: LicenseSortField,
  dir: "asc" | "desc",
): LicenseReconciliationRow[] {
  const mul = dir === "asc" ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    const as = String(av ?? "");
    const bs = String(bv ?? "");
    return as.localeCompare(bs) * mul;
  });
  return sorted;
}
