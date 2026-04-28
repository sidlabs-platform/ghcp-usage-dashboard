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
}

export interface BillingMetricConfig {
  enabled: boolean;
  /** Sync metered usage (summarized + detailed) reports. */
  meteredUsage?: boolean;
  /** Sync premium request reports. */
  premiumRequests?: boolean;
}

export interface CicdImpactConfig {
  /** Enable CI/CD impact metrics (requires Actions API calls). Default: false */
  enabled: boolean;
  /** Track build success/failure rates correlated with Copilot usage. */
  buildSuccessRate?: boolean;
  /** Track deployment frequency as a DORA metric. */
  deploymentFrequency?: boolean;
}

export interface DevProductivityImpactConfig {
  /** Enable developer productivity metrics (requires additional API calls). Default: false */
  enabled: boolean;
  /** Track time from PR creation to first review. */
  reviewTurnaround?: boolean;
  /** Track issue open→close duration. */
  issueResolution?: boolean;
  /** Track commits per developer per day. */
  commitFrequency?: boolean;
}

export interface ImpactMetricConfig {
  /** Master toggle for all Copilot impact metrics. Default: true */
  enabled: boolean;
  /** Compare merge times for Copilot-authored vs human-authored PRs. */
  prEfficiency?: boolean;
  /** Agent LoC as % of total LoC and adoption trend. */
  agentImpact?: boolean;
  /** Active users / total seats with trend. */
  licenseUtilization?: boolean;
  /** PR review suggestion stats from Copilot code review. */
  codeReviewImpact?: boolean;
  /** Cost per LoC, cost per active user tied to billing. */
  roiScore?: boolean;
  /** Days from seat assignment to first active usage. */
  timeToValue?: boolean;
  /** User journey: seat → first use → regular use → power user. */
  adoptionFunnel?: boolean;
  /** Multi-feature usage index per user. */
  engagementDepth?: boolean;
  /** One-page executive impact summary view. */
  executiveSummary?: boolean;
  /** User progression from inactive to power user stages. */
  maturityJourney?: boolean;
  /** Composite score: adoption × acceptance rate × feature breadth × engagement. */
  healthScore?: boolean;
  /** Dedicated Copilot coding agent view: PRs, LoC, success rate. */
  agentAutonomy?: boolean;
  /** Cost per PR, cost per LoC, cost per active user. */
  costPerValue?: boolean;
  /** Track users on minimum required IDE/plugin versions for LoC telemetry. */
  versionCompliance?: boolean;
  /** CI/CD impact metrics (requires Actions API). Disabled by default. */
  cicd?: CicdImpactConfig;
  /** Developer productivity metrics (requires additional APIs). Disabled by default. */
  devProductivity?: DevProductivityImpactConfig;
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
    impact: ImpactMetricConfig;
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
  | "billing"
  | "impact";

// --- Defaults ---

const DEFAULT_CONFIG: DashboardConfig = {
  metrics: {
    copilot: { enabled: true, enterprise: true, userMetrics: true, seats: true, teams: true },
    codeScanning: { enabled: true, autofix: false },
    dependabot: { enabled: true },
    secretScanning: { enabled: true },
    billing: { enabled: false, meteredUsage: true, premiumRequests: true },
    impact: {
      enabled: true,
      prEfficiency: true,
      agentImpact: true,
      licenseUtilization: true,
      codeReviewImpact: true,
      roiScore: true,
      timeToValue: true,
      adoptionFunnel: true,
      engagementDepth: true,
      executiveSummary: true,
      maturityJourney: true,
      healthScore: true,
      agentAutonomy: true,
      costPerValue: true,
      versionCompliance: true,
      cicd: { enabled: false, buildSuccessRate: true, deploymentFrequency: true },
      devProductivity: { enabled: false, reviewTurnaround: true, issueResolution: true, commitFrequency: true },
    },
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

/** Returns true when enterprise mode is effectively enabled (config + env var present). */
export function isEnterpriseEnabled(): boolean {
  const config = getDashboardConfig();
  if (!(config.metrics.copilot.enterprise ?? true)) return false;
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

export function isCopilotSubEnabled(sub: "enterprise" | "userMetrics" | "seats" | "teams"): boolean {
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

// --- Impact metric helpers ---

/** Top-level impact sub-toggle keys (flat boolean flags on ImpactMetricConfig). */
export type ImpactSubKey =
  | "prEfficiency"
  | "agentImpact"
  | "licenseUtilization"
  | "codeReviewImpact"
  | "roiScore"
  | "timeToValue"
  | "adoptionFunnel"
  | "engagementDepth"
  | "executiveSummary"
  | "maturityJourney"
  | "healthScore"
  | "agentAutonomy"
  | "costPerValue"
  | "versionCompliance";

/** Returns true when a specific impact sub-feature is enabled. */
export function isImpactSubEnabled(sub: ImpactSubKey): boolean {
  const config = getDashboardConfig();
  if (!config.metrics.impact.enabled) return false;
  return config.metrics.impact[sub] ?? true;
}

/** Returns true when a CI/CD impact sub-feature is enabled. */
export function isCicdImpactSubEnabled(sub: "buildSuccessRate" | "deploymentFrequency"): boolean {
  const config = getDashboardConfig();
  if (!config.metrics.impact.enabled) return false;
  const cicd = config.metrics.impact.cicd;
  if (!cicd?.enabled) return false;
  return cicd[sub] ?? true;
}

/** Returns true when a developer productivity impact sub-feature is enabled. */
export function isDevProductivityImpactSubEnabled(sub: "reviewTurnaround" | "issueResolution" | "commitFrequency"): boolean {
  const config = getDashboardConfig();
  if (!config.metrics.impact.enabled) return false;
  const dp = config.metrics.impact.devProductivity;
  if (!dp?.enabled) return false;
  return dp[sub] ?? true;
}

/** Returns the full impact config for client-side consumption. */
export function getImpactConfig(): ImpactMetricConfig {
  return getDashboardConfig().metrics.impact;
}

// --- Organization helpers ---

/** Resolve effective org list: GITHUB_ORGS filtered by config include/exclude. */
export function getResolvedOrgs(): string[] {
  const envOrgs = process.env.GITHUB_ORGS;
  let orgs = envOrgs ? envOrgs.split(",").map((o) => o.trim()).filter(Boolean) : [];

  const config = getDashboardConfig();
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

        // Deep-merge nested objects within impact (cicd, devProductivity)
        if (key === "impact" && overrides.metrics.impact) {
          const impactResult = result.metrics.impact as ImpactMetricConfig;
          if (overrides.metrics.impact.cicd && defaults.metrics.impact.cicd) {
            impactResult.cicd = { ...defaults.metrics.impact.cicd, ...overrides.metrics.impact.cicd };
          }
          if (overrides.metrics.impact.devProductivity && defaults.metrics.impact.devProductivity) {
            impactResult.devProductivity = { ...defaults.metrics.impact.devProductivity, ...overrides.metrics.impact.devProductivity };
          }
        }
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

  return result;
}
