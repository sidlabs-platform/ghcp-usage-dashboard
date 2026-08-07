import fs from "fs";
import path from "path";
import type { EnterpriseConfig } from "./enterprise-config";
import { getDiscoveredOrgsFromDb } from "./orgs-resolver";
import { parseReportMonths } from "@/lib/licensing/periods";

// --- Types ---

export interface CopilotMetricConfig {
  enabled: boolean;
  /** Fetch enterprise-level aggregate data. When false, GITHUB_ENTERPRISE is not required. */
  enterprise?: boolean;
  /** Fetch user-level daily metrics. When false, pages depending on user data are hidden. */
  userMetrics?: boolean;
  /** Sync Copilot seat assignments. */
  seats?: boolean;
  /** Sync team memberships. */
  teams?: boolean;
  /** Show pull request metrics page. PR data is embedded in daily metrics — this toggles page visibility. */
  pullRequests?: boolean;
}

/**
 * A time-bounded AI-credit allowance override, keyed by plan. Used to model
 * negotiated allowance changes over time (e.g. a plan's monthly allowance
 * changed on a given date) for historical reconciliation.
 *
 * `start` is inclusive; `end` (if present) is also inclusive — the window
 * covers the whole `end` day. An open-ended window (no `end`) applies from
 * `start` through the present.
 */
export interface DatedAllowance {
  /** Inclusive start date (YYYY-MM-DD) this allowance takes effect. */
  start: string;
  /** Inclusive end date (YYYY-MM-DD). Omit for an open-ended (still active) window. */
  end?: string;
  /** Monthly AI-credit allowance (credits) per normalized plan type during this window. */
  credits: Partial<Record<LicensePlanKey, number>>;
}

/** Historical reconciliation / audit-trail settings for licensing data. */
export interface LicensingHistoryConfig {
  /** Enable historical (multi-period) licensing reconciliation. Default: false. */
  enabled?: boolean;
  /**
   * Report months to reconcile. A single "YYYY-MM", an inclusive range
   * "YYYY-MM..YYYY-MM", "last_N_months", or an array mixing any of these.
   * Default: the current month.
   */
  reportMonths?: string | string[];
  /** How many days of seat assignment/revocation audit events to retain. Default: 400. */
  auditRetentionDays?: number;
  /** Emit a point-in-time snapshot file after each sync. Default: false. */
  emitSnapshots?: boolean;
  /** Directory to write monthly snapshot files to. Default: "data/licensing-snapshots". */
  snapshotDirectory?: string;
  /** Directory/path to write archived audit-log exports to. Default: "data/licensing-audit". */
  auditArchivePath?: string;
  /** Path to a persisted login → canonical-identity map file. Default: "data/identity-map.json". */
  identityMapPath?: string;
}

/** Identity-resolution settings used to reconcile logins across enterprises/orgs. */
export interface LicensingIdentityConfig {
  /** Fetch org/enterprise membership to resolve identity across renamed logins. Default: false. */
  fetchMembership?: boolean;
  /** Fetch enterprise-level consolidated identities (SCIM/SAML). Default: false. */
  fetchEnterpriseIdentities?: boolean;
  /** Fetch org-level identities. Default: false. */
  fetchOrgIdentities?: boolean;
}

/** How to source per-user AI-credit consumption for reconciliation. */
export type AicConsumptionMode = "auto" | "billing_report" | "per_user_api";

/** Per-user AI-credit consumption sourcing settings. */
export interface LicensingAicConsumptionConfig {
  /**
   * "billing_report" reads consumption from synced billing reports;
   * "per_user_api" fetches per-user consumption directly; "auto" picks
   * whichever is available. Default: "auto".
   */
  mode?: AicConsumptionMode;
  /** Optional path to a CSV export of consumption data (used to backfill/override). */
  csvPath?: string;
  /** Max concurrent per-user API requests when mode is "per_user_api"/"auto". Default: 4. */
  concurrency?: number;
}

/** Reconciliation validation / tolerance settings. */
export interface LicensingValidationConfig {
  /** Enable cross-checking reconciled totals against source reports. Default: true. */
  enabled?: boolean;
  /** Acceptable variance (percent, 0-100) between reconciled and reported AIC totals before flagging. Default: 5. */
  aicTolerancePct?: number;
}

/**
 * License + AI-Credit reconciliation settings. These drive the
 * License & AI Credits view, which joins synced seat data with per-user
 * AI-credit consumption and applies negotiated pricing / allowances that are
 * NOT returned by the GitHub API and therefore must be configured.
 *
 * All fields are optional; {@link getLicensingConfig} fills in field-level
 * defaults so partial config (or none at all) still works out of the box.
 */
export interface LicensingConfig {
  /** USD value of one AI credit. GitHub flex-billing default: 0.01. */
  creditToUsd?: number;
  /** ISO currency code for display. Default: "USD". */
  currency?: string;
  /** Monthly negotiated seat list price (USD) per normalized plan type. */
  licenseCost?: Partial<Record<LicensePlanKey, number>>;
  /** Monthly AI-credit allowance (credits) per normalized plan type. */
  aicAllowance?: Partial<Record<LicensePlanKey, number>>;
  /** Optional per-user AI-credit budget override (USD), keyed by login. */
  perUserBudgetUsd?: Record<string, number>;
  /**
   * Time-bounded allowance overrides, applied instead of the static
   * `aicAllowance` for periods they cover. Windows must not overlap for the
   * same plan; malformed/overlapping entries are dropped with a warning.
   */
  datedAllowances?: DatedAllowance[];
  /** Historical reconciliation / audit-trail settings. */
  history?: LicensingHistoryConfig;
  /** Identity-resolution settings used to reconcile logins across enterprises/orgs. */
  identity?: LicensingIdentityConfig;
  /** Per-user AI-credit consumption sourcing settings. */
  aicConsumption?: LicensingAicConsumptionConfig;
  /** Reconciliation validation / tolerance settings. */
  validation?: LicensingValidationConfig;
}

export type LicensePlanKey = "business" | "enterprise" | "unknown";

export interface BillingMetricConfig {
  enabled: boolean;
  /** Sync metered usage (summarized + detailed) reports. */
  meteredUsage?: boolean;
  /** Sync premium request reports (legacy — use aiCredits instead). */
  premiumRequests?: boolean;
  /** Sync AI credit reports (replaces premium requests as of June 2026). */
  aiCredits?: boolean;
  /** License + AI-credit reconciliation pricing/allowance settings. */
  licensing?: LicensingConfig;
}

/** Resolved historical reconciliation settings with all fields populated. */
export interface ResolvedLicensingHistoryConfig {
  enabled: boolean;
  reportMonths: string | string[];
  auditRetentionDays: number;
  emitSnapshots: boolean;
  snapshotDirectory: string;
  auditArchivePath: string;
  identityMapPath: string;
}

/** Resolved identity-resolution settings with all fields populated. */
export interface ResolvedLicensingIdentityConfig {
  fetchMembership: boolean;
  fetchEnterpriseIdentities: boolean;
  fetchOrgIdentities: boolean;
}

/** Resolved AIC consumption-sourcing settings with all fields populated. */
export interface ResolvedLicensingAicConsumptionConfig {
  mode: AicConsumptionMode;
  csvPath?: string;
  concurrency: number;
}

/** Resolved reconciliation validation settings with all fields populated. */
export interface ResolvedLicensingValidationConfig {
  enabled: boolean;
  aicTolerancePct: number;
}

/** Resolved licensing config with all fields populated. */
export interface ResolvedLicensingConfig {
  creditToUsd: number;
  currency: string;
  licenseCost: Record<LicensePlanKey, number>;
  aicAllowance: Record<LicensePlanKey, number>;
  perUserBudgetUsd: Record<string, number>;
  /** Time-bounded allowance overrides, sorted by start date; malformed/overlapping entries removed. */
  datedAllowances: DatedAllowance[];
  history: ResolvedLicensingHistoryConfig;
  identity: ResolvedLicensingIdentityConfig;
  aicConsumption: ResolvedLicensingAicConsumptionConfig;
  validation: ResolvedLicensingValidationConfig;
}

export interface MetricConfig {
  enabled: boolean;
}

export interface CodeScanningMetricConfig {
  enabled: boolean;
  /** Fetch per-alert autofix status from GitHub API. Requires 1 API call per open alert. Default: false */
  autofix?: boolean;
}

export interface SecurityConfig {
  syncIntervalMinutes: number;
  backfillDays: number;
}

export interface AutoSyncConfig {
  /** Enable automatic daily incremental sync. Default: false */
  enabled: boolean;
  /** UTC time to run the sync in "HH:MM" format. Default: "03:00" */
  utcTime: string;
}

export interface OrganizationsConfig {
  /** If non-empty, only these orgs are synced (must be a subset of GITHUB_ORGS). */
  include?: string[];
  /** These orgs are excluded from GITHUB_ORGS. */
  exclude?: string[];
}

export interface DashboardConfig {
  /** Multi-enterprise configuration. When present, overrides legacy GITHUB_ENTERPRISE env var. */
  enterprises?: EnterpriseConfig[];
  metrics: {
    copilot: CopilotMetricConfig;
    codeScanning: CodeScanningMetricConfig;
    dependabot: MetricConfig;
    secretScanning: MetricConfig;
    billing: BillingMetricConfig;
  };
  organizations?: OrganizationsConfig;
  security: SecurityConfig;
  autoSync?: AutoSyncConfig;
}

export type MetricCategory =
  | "copilot"
  | "codeScanning"
  | "dependabot"
  | "secretScanning"
  | "billing";

// --- Defaults ---

const DEFAULT_CONFIG: DashboardConfig = {
  metrics: {
    copilot: { enabled: true, enterprise: true, userMetrics: true, seats: true, teams: true, pullRequests: true },
    codeScanning: { enabled: true, autofix: false },
    dependabot: { enabled: true },
    secretScanning: { enabled: true },
    billing: { enabled: false, meteredUsage: true, premiumRequests: true, aiCredits: true },
  },
  organizations: { include: [], exclude: [] },
  security: {
    syncIntervalMinutes: 60,
    backfillDays: 90,
  },
  autoSync: {
    enabled: false,
    utcTime: "03:00",
  },
};

// --- Cache ---

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedConfig: DashboardConfig | null = null;
let cacheTimestamp = 0;

// --- Public API ---

export function getDashboardConfig(): DashboardConfig {
  const now = Date.now();
  if (cachedConfig && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedConfig;
  }

  const configPath = path.join(process.cwd(), "dashboard-config.json");

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DashboardConfig>;
    // Deep-merge with defaults for backward compatibility
    const merged = deepMergeConfig(DEFAULT_CONFIG, parsed);
    cachedConfig = merged;
    cacheTimestamp = now;
    return merged;
  } catch (err) {
    console.warn(
      "Failed to read dashboard-config.json, using defaults:",
      err instanceof Error ? err.message : err
    );
    cachedConfig = DEFAULT_CONFIG;
    cacheTimestamp = now;
    return DEFAULT_CONFIG;
  }
}

export function isMetricEnabled(category: MetricCategory): boolean {
  const config = getDashboardConfig();
  return config.metrics[category]?.enabled ?? true;
}

export function getSecurityConfig(): SecurityConfig {
  return getDashboardConfig().security;
}

export function getAutoSyncConfig(): AutoSyncConfig {
  return getDashboardConfig().autoSync ?? { enabled: false, utcTime: "03:00" };
}

/** Returns true when code scanning autofix enrichment is enabled in config. */
export function isCodeScanningAutofixEnabled(): boolean {
  const config = getDashboardConfig();
  if (!config.metrics.codeScanning.enabled) return false;
  return config.metrics.codeScanning.autofix ?? false;
}

// --- Enterprise helpers ---

let _enterpriseWarned = false;

/** Returns true when enterprise mode is effectively enabled (config + env var present, or multi-enterprise configured). */
export function isEnterpriseEnabled(): boolean {
  const config = getDashboardConfig();
  if (!(config.metrics.copilot.enterprise ?? true)) return false;

  // Multi-enterprise mode: enterprises defined in dashboard-config.json
  if (config.enterprises && config.enterprises.length > 0) return true;

  // Legacy single-enterprise mode: require env var
  if (!process.env.GITHUB_ENTERPRISE) {
    if (config.metrics.copilot.enterprise === true && !_enterpriseWarned) {
      console.warn("[Config] copilot.enterprise=true but GITHUB_ENTERPRISE env var is missing — treating as disabled");
      _enterpriseWarned = true;
    }
    return false;
  }
  return true;
}

// --- Copilot sub-toggle helpers ---

export function isCopilotSubEnabled(sub: "enterprise" | "userMetrics" | "seats" | "teams" | "pullRequests"): boolean {
  const config = getDashboardConfig();
  if (!config.metrics.copilot.enabled) return false;
  if (sub === "enterprise") return isEnterpriseEnabled();
  return config.metrics.copilot[sub] ?? true;
}

// --- Billing helpers ---

/** Effective billing state: force-disabled when enterprise is off. */
export function getEffectiveBillingEnabled(): boolean {
  if (!isEnterpriseEnabled()) return false;
  return isMetricEnabled("billing");
}

export function isBillingSubEnabled(sub: "meteredUsage" | "premiumRequests" | "aiCredits"): boolean {
  if (!getEffectiveBillingEnabled()) return false;
  const config = getDashboardConfig();
  return (config.metrics.billing as BillingMetricConfig)[sub] ?? true;
}

// --- Licensing (License & AI Credits reconciliation) helpers ---

/**
 * Built-in defaults for license pricing and AI-credit allowances. These mirror
 * the GitHub Copilot flex-billing list prices used by the copilot-aic-report
 * tool. Override any field via `metrics.billing.licensing` in dashboard-config.json.
 */
export const DEFAULT_LICENSING: ResolvedLicensingConfig = {
  creditToUsd: 0.01,
  currency: "USD",
  licenseCost: { business: 19, enterprise: 39, unknown: 0 },
  aicAllowance: { business: 1900, enterprise: 3900, unknown: 0 },
  perUserBudgetUsd: {},
  datedAllowances: [],
  history: {
    enabled: false,
    reportMonths: "last_1_months",
    auditRetentionDays: 400,
    emitSnapshots: false,
    snapshotDirectory: "data/licensing-snapshots",
    auditArchivePath: "data/licensing-audit",
    identityMapPath: "data/identity-map.json",
  },
  identity: {
    fetchMembership: false,
    fetchEnterpriseIdentities: false,
    fetchOrgIdentities: false,
  },
  aicConsumption: {
    mode: "auto",
    concurrency: 4,
  },
  validation: {
    enabled: true,
    aicTolerancePct: 5,
  },
};

// Pragmatic, documented bounds used to validate historical licensing config.
const MIN_AUDIT_RETENTION_DAYS = 1;
const MAX_AUDIT_RETENTION_DAYS = 3650; // 10 years
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 20;
const MIN_TOLERANCE_PCT = 0;
const MAX_TOLERANCE_PCT = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AIC_CONSUMPTION_MODES: AicConsumptionMode[] = ["auto", "billing_report", "per_user_api"];

/** True when `value` is a valid calendar date in "YYYY-MM-DD" form. */
function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  // Guard against JS Date normalizing an out-of-range day/month (e.g. 2026-02-30 -> 2026-03-02).
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** Filter a plan-keyed credits map down to non-negative numeric entries. */
function sanitizeCreditsMap(
  raw: Partial<Record<LicensePlanKey, number>> | undefined,
  contextLabel: string
): Partial<Record<LicensePlanKey, number>> {
  const result: Partial<Record<LicensePlanKey, number>> = {};
  for (const [plan, value] of Object.entries(raw ?? {})) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[plan as LicensePlanKey] = value;
    } else {
      console.warn(`[Config] Ignoring negative/invalid ${contextLabel} value for plan "${plan}": ${value}`);
    }
  }
  return result;
}

/**
 * Validate and sanitize configured `datedAllowances`: drops entries with
 * malformed dates, invalid (end before start) ranges, or negative credit
 * values, then drops any entry whose window overlaps an earlier (by start
 * date) entry for the same plan. Returns entries sorted by start date.
 */
function sanitizeDatedAllowances(raw: DatedAllowance[] | undefined): DatedAllowance[] {
  if (!raw || raw.length === 0) return [];

  const candidates: DatedAllowance[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.start !== "string" || !isValidDateString(entry.start)) {
      console.warn(`[Config] Ignoring dated allowance with malformed start date: ${JSON.stringify(entry)}`);
      continue;
    }
    if (entry.end !== undefined && (typeof entry.end !== "string" || !isValidDateString(entry.end))) {
      console.warn(`[Config] Ignoring dated allowance with malformed end date: ${JSON.stringify(entry)}`);
      continue;
    }
    if (entry.end !== undefined && entry.end < entry.start) {
      console.warn(`[Config] Ignoring dated allowance with end before start: ${JSON.stringify(entry)}`);
      continue;
    }
    const credits = sanitizeCreditsMap(entry.credits, "dated allowance");
    if (Object.keys(credits).length === 0) {
      console.warn(`[Config] Ignoring dated allowance with no valid credit values: ${JSON.stringify(entry)}`);
      continue;
    }
    candidates.push({ start: entry.start, end: entry.end, credits });
  }

  // Sort ascending by start date so earlier windows take precedence on overlap.
  candidates.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const accepted: DatedAllowance[] = [];
  // Track the latest accepted end date (or "open-ended") per plan.
  const lastEndByPlan = new Map<LicensePlanKey, string | null>(); // null = open-ended (no end)

  for (const entry of candidates) {
    const plansInEntry = Object.keys(entry.credits) as LicensePlanKey[];
    const overlaps = plansInEntry.some((plan) => {
      const lastEnd = lastEndByPlan.get(plan);
      if (lastEnd === undefined) return false; // no prior window for this plan
      if (lastEnd === null) return true; // prior window is open-ended: everything after overlaps
      return entry.start <= lastEnd;
    });

    if (overlaps) {
      console.warn(`[Config] Ignoring dated allowance that overlaps an earlier window: ${JSON.stringify(entry)}`);
      continue;
    }

    accepted.push(entry);
    for (const plan of plansInEntry) {
      lastEndByPlan.set(plan, entry.end ?? null);
    }
  }

  return accepted;
}

/** Resolve `history` settings with field-level defaults and bounds applied. */
function resolveHistoryConfig(raw: LicensingHistoryConfig | undefined): ResolvedLicensingHistoryConfig {
  const defaults = DEFAULT_LICENSING.history;

  let reportMonths: string | string[] = defaults.reportMonths;
  if (raw?.reportMonths !== undefined) {
    try {
      parseReportMonths(raw.reportMonths); // validate syntax only; keep the raw form
      reportMonths = raw.reportMonths;
    } catch (err) {
      console.warn(
        `[Config] Ignoring malformed licensing.history.reportMonths (${JSON.stringify(raw.reportMonths)}): ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  let auditRetentionDays = defaults.auditRetentionDays;
  if (typeof raw?.auditRetentionDays === "number") {
    if (raw.auditRetentionDays >= MIN_AUDIT_RETENTION_DAYS && raw.auditRetentionDays <= MAX_AUDIT_RETENTION_DAYS) {
      auditRetentionDays = raw.auditRetentionDays;
    } else {
      console.warn(
        `[Config] licensing.history.auditRetentionDays (${raw.auditRetentionDays}) out of bounds [${MIN_AUDIT_RETENTION_DAYS}, ${MAX_AUDIT_RETENTION_DAYS}]; using default ${defaults.auditRetentionDays}`
      );
    }
  }

  return {
    enabled: raw?.enabled ?? defaults.enabled,
    reportMonths,
    auditRetentionDays,
    emitSnapshots: raw?.emitSnapshots ?? defaults.emitSnapshots,
    snapshotDirectory: raw?.snapshotDirectory || defaults.snapshotDirectory,
    auditArchivePath: raw?.auditArchivePath || defaults.auditArchivePath,
    identityMapPath: raw?.identityMapPath || defaults.identityMapPath,
  };
}

/** Resolve `identity` settings with field-level defaults applied. */
function resolveIdentityConfig(raw: LicensingIdentityConfig | undefined): ResolvedLicensingIdentityConfig {
  const defaults = DEFAULT_LICENSING.identity;
  return {
    fetchMembership: raw?.fetchMembership ?? defaults.fetchMembership,
    fetchEnterpriseIdentities: raw?.fetchEnterpriseIdentities ?? defaults.fetchEnterpriseIdentities,
    fetchOrgIdentities: raw?.fetchOrgIdentities ?? defaults.fetchOrgIdentities,
  };
}

/** Resolve `aicConsumption` settings with field-level defaults and bounds applied. */
function resolveAicConsumptionConfig(
  raw: LicensingAicConsumptionConfig | undefined
): ResolvedLicensingAicConsumptionConfig {
  const defaults = DEFAULT_LICENSING.aicConsumption;

  let mode = defaults.mode;
  if (raw?.mode !== undefined) {
    if (AIC_CONSUMPTION_MODES.includes(raw.mode)) {
      mode = raw.mode;
    } else {
      console.warn(`[Config] Ignoring invalid licensing.aicConsumption.mode "${raw.mode}"; using default "${defaults.mode}"`);
    }
  }

  let concurrency = defaults.concurrency;
  if (typeof raw?.concurrency === "number") {
    if (raw.concurrency >= MIN_CONCURRENCY && raw.concurrency <= MAX_CONCURRENCY) {
      concurrency = raw.concurrency;
    } else {
      console.warn(
        `[Config] licensing.aicConsumption.concurrency (${raw.concurrency}) out of bounds [${MIN_CONCURRENCY}, ${MAX_CONCURRENCY}]; using default ${defaults.concurrency}`
      );
    }
  }

  return { mode, csvPath: raw?.csvPath, concurrency };
}

/** Resolve `validation` settings with field-level defaults and bounds applied. */
function resolveValidationConfig(raw: LicensingValidationConfig | undefined): ResolvedLicensingValidationConfig {
  const defaults = DEFAULT_LICENSING.validation;

  let aicTolerancePct = defaults.aicTolerancePct;
  if (typeof raw?.aicTolerancePct === "number") {
    if (raw.aicTolerancePct >= MIN_TOLERANCE_PCT && raw.aicTolerancePct <= MAX_TOLERANCE_PCT) {
      aicTolerancePct = raw.aicTolerancePct;
    } else {
      console.warn(
        `[Config] licensing.validation.aicTolerancePct (${raw.aicTolerancePct}) out of bounds [${MIN_TOLERANCE_PCT}, ${MAX_TOLERANCE_PCT}]; using default ${defaults.aicTolerancePct}`
      );
    }
  }

  return {
    enabled: raw?.enabled ?? defaults.enabled,
    aicTolerancePct,
  };
}

/**
 * Resolve the licensing config with field-level defaults applied. Safe to call
 * with no configured `licensing` block — always returns a fully populated object.
 */
export function getLicensingConfig(): ResolvedLicensingConfig {
  const configured = (getDashboardConfig().metrics.billing as BillingMetricConfig).licensing ?? {};
  const rawBudgets = configured.perUserBudgetUsd ?? {};
  const perUserBudgetUsd: Record<string, number> = {};
  for (const [login, amount] of Object.entries(rawBudgets)) {
    perUserBudgetUsd[login.toLowerCase()] = amount;
  }

  const licenseCost = sanitizeCreditsMap(configured.licenseCost, "licenseCost");
  const aicAllowance = sanitizeCreditsMap(configured.aicAllowance, "aicAllowance");

  return {
    creditToUsd:
      typeof configured.creditToUsd === "number" && configured.creditToUsd >= 0
        ? configured.creditToUsd
        : DEFAULT_LICENSING.creditToUsd,
    currency: configured.currency || DEFAULT_LICENSING.currency,
    licenseCost: { ...DEFAULT_LICENSING.licenseCost, ...licenseCost },
    aicAllowance: { ...DEFAULT_LICENSING.aicAllowance, ...aicAllowance },
    perUserBudgetUsd,
    datedAllowances: sanitizeDatedAllowances(configured.datedAllowances),
    history: resolveHistoryConfig(configured.history),
    identity: resolveIdentityConfig(configured.identity),
    aicConsumption: resolveAicConsumptionConfig(configured.aicConsumption),
    validation: resolveValidationConfig(configured.validation),
  };
}

// --- Organization helpers ---

/** Resolve effective org list: GITHUB_ORGS filtered by config include/exclude, or aggregated from all enterprises in multi-enterprise mode. */
export function getResolvedOrgs(): string[] {
  const config = getDashboardConfig();

  // Multi-enterprise mode: resolve orgs per enterprise (include list + DB cache + exclude)
  if (config.enterprises && config.enterprises.length > 0) {
    const allOrgs = new Set<string>();
    for (const ent of config.enterprises) {
      const include = ent.organizations?.include ?? [];
      const exclude = new Set((ent.organizations?.exclude ?? []).map((o) => o.toLowerCase()));

      let entOrgs: string[];
      if (include.length > 0) {
        entOrgs = [...include];
      } else {
        entOrgs = getDiscoveredOrgsFromDb(ent.slug);
      }

      for (const org of entOrgs) {
        if (!exclude.has(org.toLowerCase())) {
          allOrgs.add(org);
        }
      }
    }
    return [...allOrgs];
  }

  // Legacy single-enterprise mode
  const envOrgs = process.env.GITHUB_ORGS;
  let orgs = envOrgs ? envOrgs.split(",").map((o) => o.trim()).filter(Boolean) : [];

  // When GITHUB_ORGS is blank, fall back to DB-cached auto-discovered orgs
  if (orgs.length === 0) {
    const legacySlug = process.env.GITHUB_ENTERPRISE;
    if (legacySlug) {
      orgs = getDiscoveredOrgsFromDb(legacySlug);
    }
  }

  const orgConfig = config.organizations ?? {};

  const include = orgConfig.include ?? [];
  const exclude = orgConfig.exclude ?? [];

  if (include.length > 0) {
    const includeSet = new Set(include.map((o) => o.toLowerCase()));
    orgs = orgs.filter((o) => includeSet.has(o.toLowerCase()));
  }

  if (exclude.length > 0) {
    const excludeSet = new Set(exclude.map((o) => o.toLowerCase()));
    orgs = orgs.filter((o) => !excludeSet.has(o.toLowerCase()));
  }

  return orgs;
}

// --- Deep merge utility ---

function deepMergeConfig(defaults: DashboardConfig, overrides: Partial<DashboardConfig>): DashboardConfig {
  const result = { ...defaults };

  if (overrides.metrics) {
    result.metrics = { ...defaults.metrics };
    for (const key of Object.keys(overrides.metrics) as (keyof typeof overrides.metrics)[]) {
      if (overrides.metrics[key] && typeof overrides.metrics[key] === "object") {
        result.metrics[key] = { ...defaults.metrics[key], ...overrides.metrics[key] } as any;
      }
    }
  }

  if (overrides.organizations) {
    result.organizations = { ...defaults.organizations, ...overrides.organizations };
  }

  if (overrides.security) {
    result.security = { ...defaults.security, ...overrides.security };
  }

  if (overrides.autoSync) {
    result.autoSync = { ...(defaults.autoSync ?? { enabled: false, utcTime: "03:00" }), ...overrides.autoSync };
  }

  // Preserve multi-enterprise config (array, not deep-merged)
  if (overrides.enterprises) {
    result.enterprises = overrides.enterprises;
  }

  return result;
}
