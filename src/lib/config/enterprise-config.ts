// Multi-enterprise configuration — server-only + client-safe types & helpers

import { getDashboardConfig, type MetricCategory } from "./dashboard-config";

// ── Types ─────────────────────────────────────────────────────────────

/** Server-only enterprise config (contains auth env var names). */
export interface EnterpriseConfig {
  slug: string;
  displayName: string;
  /** Env var name that holds the PAT for this enterprise. */
  tokenEnvVar: string;
  /** Env var name for GitHub App ID (optional). */
  appIdEnvVar?: string;
  /** Env var name for GitHub App private key PEM (optional). */
  appPrivateKeyEnvVar?: string;
  /** Env var name for GitHub App installation ID (optional). */
  appInstallationIdEnvVar?: string;
  /** Organization include/exclude for this enterprise. */
  organizations?: {
    include?: string[];
    exclude?: string[];
  };
  /** Per-enterprise metric overrides. When present, shallow-merges with global metrics config. */
  metrics?: EnterpriseMetricOverrides;
}

/** Per-enterprise overrides for metric toggles. Each field is optional; when omitted the global config is used. */
export interface EnterpriseMetricOverrides {
  copilot?: { enabled?: boolean; enterprise?: boolean; userMetrics?: boolean; seats?: boolean; teams?: boolean; pullRequests?: boolean };
  codeScanning?: { enabled?: boolean; autofix?: boolean };
  dependabot?: { enabled?: boolean };
  secretScanning?: { enabled?: boolean };
  billing?: { enabled?: boolean; meteredUsage?: boolean; premiumRequests?: boolean };
}

/** Client-safe enterprise info (no auth details). */
export interface EnterpriseInfo {
  slug: string;
  displayName: string;
}

/** Resolved auth credentials for a specific enterprise. */
export interface EnterpriseAuth {
  token: string;
  appConfig?: {
    appId: string;
    privateKey: string;
    installationId: string;
  };
}

// ── Cache ─────────────────────────────────────────────────────────────

let cachedEnterprises: EnterpriseConfig[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function invalidateCache(): void {
  cachedEnterprises = null;
  cacheTimestamp = 0;
}

// ── Core helpers ──────────────────────────────────────────────────────

/**
 * Returns the list of configured enterprises. If `enterprises` array is present
 * in dashboard-config.json, uses that. Otherwise, synthesizes a single-enterprise
 * config from legacy environment variables for backward compatibility.
 */
export function getConfiguredEnterprises(): EnterpriseConfig[] {
  const now = Date.now();
  if (cachedEnterprises && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEnterprises;
  }

  const config = getDashboardConfig();

  if (config.enterprises && config.enterprises.length > 0) {
    cachedEnterprises = config.enterprises;
    cacheTimestamp = now;
    return cachedEnterprises;
  }

  // Legacy backward compatibility: synthesize from env vars
  const slug = process.env.GITHUB_ENTERPRISE;
  if (!slug) {
    cachedEnterprises = [];
    cacheTimestamp = now;
    return cachedEnterprises;
  }

  const hasApp = !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.GITHUB_APP_INSTALLATION_ID
  );

  const envOrgs = process.env.GITHUB_ORGS;
  const include = envOrgs ? envOrgs.split(",").map((o) => o.trim()).filter(Boolean) : [];

  cachedEnterprises = [
    {
      slug,
      displayName: slug,
      tokenEnvVar: "GITHUB_TOKEN",
      ...(hasApp
        ? {
            appIdEnvVar: "GITHUB_APP_ID",
            appPrivateKeyEnvVar: "GITHUB_APP_PRIVATE_KEY",
            appInstallationIdEnvVar: "GITHUB_APP_INSTALLATION_ID",
          }
        : {}),
      organizations: {
        include,
        exclude: [],
      },
    },
  ];
  cacheTimestamp = now;
  return cachedEnterprises;
}

/**
 * Get a specific enterprise config by slug. Throws if not found.
 */
export function getEnterpriseConfig(slug: string): EnterpriseConfig {
  const enterprises = getConfiguredEnterprises();
  const found = enterprises.find((e) => e.slug === slug);
  if (!found) {
    throw new Error(
      `Enterprise "${slug}" not found in configuration. ` +
        `Available: ${enterprises.map((e) => e.slug).join(", ") || "(none)"}`
    );
  }
  return found;
}

/**
 * Returns client-safe enterprise list (no auth details). Safe to send in API responses.
 */
export function getClientEnterpriseList(): EnterpriseInfo[] {
  return getConfiguredEnterprises().map((e) => ({
    slug: e.slug,
    displayName: e.displayName,
  }));
}

/**
 * Resolve auth credentials for a specific enterprise by reading its env vars.
 */
export function getEnterpriseAuth(slug: string): EnterpriseAuth {
  const config = getEnterpriseConfig(slug);

  const token = process.env[config.tokenEnvVar];
  if (!token) {
    throw new Error(
      `PAT not found: environment variable "${config.tokenEnvVar}" is not set for enterprise "${slug}".`
    );
  }

  let appConfig: EnterpriseAuth["appConfig"];
  if (config.appIdEnvVar && config.appPrivateKeyEnvVar && config.appInstallationIdEnvVar) {
    const appId = process.env[config.appIdEnvVar];
    const rawKey = process.env[config.appPrivateKeyEnvVar];
    const installationId = process.env[config.appInstallationIdEnvVar];

    if (appId && rawKey && installationId) {
      appConfig = {
        appId,
        privateKey: rawKey.replace(/\\n/g, "\n"),
        installationId,
      };
    }
  }

  return { token, appConfig };
}

/**
 * Returns true when more than one enterprise is configured.
 */
export function isMultiEnterprise(): boolean {
  return getConfiguredEnterprises().length > 1;
}

/**
 * Returns all configured enterprise slugs.
 */
export function getEnterpriseSlugs(): string[] {
  return getConfiguredEnterprises().map((e) => e.slug);
}

/**
 * Resolve the effective organization list for a specific enterprise,
 * applying the include/exclude rules from its config.
 */
export function getResolvedOrgsForEnterprise(slug: string): string[] {
  const config = getEnterpriseConfig(slug);
  const orgConfig = config.organizations ?? {};
  const include = orgConfig.include ?? [];
  const exclude = orgConfig.exclude ?? [];

  let orgs: string[];

  if (include.length > 0) {
    // Explicit org list from config — use it directly
    orgs = [...include];
  } else {
    // No explicit include list — fall back to auto-discovered orgs cached in DB
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getEnterpriseOrgs } = require("@/lib/db/orgs-repo") as {
        getEnterpriseOrgs: (slug: string) => string[];
      };
      orgs = getEnterpriseOrgs(slug);
    } catch {
      // DB may not be initialized yet — return empty
      orgs = [];
    }
  }

  if (exclude.length > 0) {
    const excludeSet = new Set(exclude.map((o) => o.toLowerCase()));
    orgs = orgs.filter((o) => !excludeSet.has(o.toLowerCase()));
  }

  return orgs;
}

/** Reset cache — useful after config file changes. */
export function resetEnterpriseConfigCache(): void {
  invalidateCache();
}

/**
 * Resolve a default scope + scopeId for API routes that need a fallback.
 * In multi-enterprise mode, defaults to the first enterprise slug.
 * In legacy mode, uses GITHUB_ENTERPRISE env var.
 * Falls back to the first resolved org if enterprise mode is off.
 */
export function resolveDefaultScope(): { scope: string; scopeId: string } {
  const enterprises = getConfiguredEnterprises();
  if (enterprises.length > 0) {
    return { scope: "enterprise", scopeId: enterprises[0].slug };
  }
  return { scope: "org", scopeId: "" };
}

// ── Per-enterprise metric resolution ──────────────────────────────────

/**
 * Check if a metric category is enabled for a specific enterprise.
 * Shallow-merges enterprise overrides onto global config.
 */
export function isMetricEnabledForEnterprise(slug: string, category: MetricCategory): boolean {
  const config = getDashboardConfig();
  const globalEnabled = config.metrics[category]?.enabled ?? true;

  const entConfig = getEnterpriseConfig(slug);
  const override = entConfig.metrics?.[category];
  if (override && typeof override.enabled === "boolean") {
    return override.enabled;
  }

  return globalEnabled;
}

/**
 * Check if a Copilot sub-toggle is enabled for a specific enterprise.
 */
export function isCopilotSubEnabledForEnterprise(
  slug: string,
  sub: "enterprise" | "userMetrics" | "seats" | "teams" | "pullRequests",
): boolean {
  if (!isMetricEnabledForEnterprise(slug, "copilot")) return false;

  const config = getDashboardConfig();
  const rawGlobal = (config.metrics.copilot as unknown as Record<string, unknown>)[sub];
  const globalValue = typeof rawGlobal === "boolean" ? rawGlobal : true;

  const entConfig = getEnterpriseConfig(slug);
  const override = entConfig.metrics?.copilot;
  if (override && typeof (override as Record<string, unknown>)[sub] === "boolean") {
    return (override as Record<string, unknown>)[sub] as boolean;
  }

  return globalValue as boolean;
}

/**
 * Check if billing is enabled for a specific enterprise.
 */
export function isBillingEnabledForEnterprise(slug: string): boolean {
  return isMetricEnabledForEnterprise(slug, "billing");
}

/**
 * Check if a billing sub-toggle is enabled for a specific enterprise.
 */
export function isBillingSubEnabledForEnterprise(
  slug: string,
  sub: "meteredUsage" | "premiumRequests",
): boolean {
  if (!isBillingEnabledForEnterprise(slug)) return false;

  const config = getDashboardConfig();
  const rawGlobal = (config.metrics.billing as unknown as Record<string, unknown>)[sub];
  const globalValue = typeof rawGlobal === "boolean" ? rawGlobal : true;

  const entConfig = getEnterpriseConfig(slug);
  const override = entConfig.metrics?.billing;
  if (override && typeof (override as Record<string, unknown>)[sub] === "boolean") {
    return (override as Record<string, unknown>)[sub] as boolean;
  }

  return globalValue as boolean;
}

/**
 * Check if code scanning autofix is enabled for a specific enterprise.
 */
export function isCodeScanningAutofixEnabledForEnterprise(slug: string): boolean {
  if (!isMetricEnabledForEnterprise(slug, "codeScanning")) return false;

  const config = getDashboardConfig();
  const globalAutofix = config.metrics.codeScanning?.autofix ?? false;

  const entConfig = getEnterpriseConfig(slug);
  const override = entConfig.metrics?.codeScanning;
  if (override && typeof override.autofix === "boolean") {
    return override.autofix;
  }

  return globalAutofix;
}

/**
 * Returns true if a metric category is enabled for ANY configured enterprise.
 * Used for page visibility — show a page if at least one enterprise has the metric enabled.
 */
export function isMetricEnabledForAnyEnterprise(category: MetricCategory): boolean {
  const enterprises = getConfiguredEnterprises();
  if (enterprises.length === 0) {
    // Legacy mode — fall back to global config
    const config = getDashboardConfig();
    return config.metrics[category]?.enabled ?? true;
  }
  return enterprises.some((e) => isMetricEnabledForEnterprise(e.slug, category));
}

/**
 * Returns true if a Copilot sub-toggle is enabled for ANY configured enterprise.
 */
export function isCopilotSubEnabledForAnyEnterprise(
  sub: "enterprise" | "userMetrics" | "seats" | "teams" | "pullRequests",
): boolean {
  const enterprises = getConfiguredEnterprises();
  if (enterprises.length === 0) {
    const config = getDashboardConfig();
    if (!config.metrics.copilot.enabled) return false;
    const rawVal = (config.metrics.copilot as unknown as Record<string, unknown>)[sub];
    return typeof rawVal === "boolean" ? rawVal : true;
  }
  return enterprises.some((e) => isCopilotSubEnabledForEnterprise(e.slug, sub));
}

/**
 * Returns true if a billing sub-toggle is enabled for ANY configured enterprise.
 */
export function isBillingSubEnabledForAnyEnterprise(
  sub: "meteredUsage" | "premiumRequests",
): boolean {
  const enterprises = getConfiguredEnterprises();
  if (enterprises.length === 0) {
    const config = getDashboardConfig();
    if (!config.metrics.billing?.enabled) return false;
    const rawVal = (config.metrics.billing as unknown as Record<string, unknown>)[sub];
    return typeof rawVal === "boolean" ? rawVal : true;
  }
  return enterprises.some((e) => isBillingSubEnabledForEnterprise(e.slug, sub));
}

/**
 * Client-safe per-enterprise effective metric settings.
 * Returns the resolved enabled/disabled state for each metric category per enterprise.
 */
export function getClientEnterpriseMetrics(): Record<string, Record<string, boolean>> {
  const result: Record<string, Record<string, boolean>> = {};
  for (const ent of getConfiguredEnterprises()) {
    result[ent.slug] = {
      copilot: isMetricEnabledForEnterprise(ent.slug, "copilot"),
      codeScanning: isMetricEnabledForEnterprise(ent.slug, "codeScanning"),
      dependabot: isMetricEnabledForEnterprise(ent.slug, "dependabot"),
      secretScanning: isMetricEnabledForEnterprise(ent.slug, "secretScanning"),
      billing: isMetricEnabledForEnterprise(ent.slug, "billing"),
    };
  }
  return result;
}
