import fs from "fs";
import path from "path";
import type { EnterpriseConfig } from "./enterprise-config";

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

export interface BillingMetricConfig {
  enabled: boolean;
  /** Sync metered usage (summarized + detailed) reports. */
  meteredUsage?: boolean;
  /** Sync premium request reports. */
  premiumRequests?: boolean;
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
    copilot: { enabled: true, enterprise: true, userMetrics: true, seats: true, teams: true },
    codeScanning: { enabled: true, autofix: false },
    dependabot: { enabled: true },
    secretScanning: { enabled: true },
    billing: { enabled: false, meteredUsage: true, premiumRequests: true },
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

export function isBillingSubEnabled(sub: "meteredUsage" | "premiumRequests"): boolean {
  if (!getEffectiveBillingEnabled()) return false;
  const config = getDashboardConfig();
  return (config.metrics.billing as BillingMetricConfig)[sub] ?? true;
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
        // Fall back to auto-discovered orgs cached in DB
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getEnterpriseOrgs } = require("@/lib/db/orgs-repo") as {
            getEnterpriseOrgs: (slug: string) => string[];
          };
          entOrgs = getEnterpriseOrgs(ent.slug);
        } catch {
          entOrgs = [];
        }
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
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getEnterpriseOrgs } = require("@/lib/db/orgs-repo") as {
        getEnterpriseOrgs: (slug: string) => string[];
      };
      const legacySlug = process.env.GITHUB_ENTERPRISE;
      if (legacySlug) {
        orgs = getEnterpriseOrgs(legacySlug);
      }
    } catch {
      // DB not initialized yet — return empty
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
