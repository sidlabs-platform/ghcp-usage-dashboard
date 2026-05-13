// Multi-enterprise configuration — server-only + client-safe types & helpers

import { getDashboardConfig, type MetricCategory } from "./dashboard-config";
import { getDiscoveredOrgsFromDb } from "./orgs-resolver";

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

  const hasApp = !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.GITHUB_APP_INSTALLATION_ID
  );

  const envOrgs = process.env.GITHUB_ORGS;
  const include = envOrgs ? envOrgs.split(",").map((o) => o.trim()).filter(Boolean) : [];

  if (slug) {
    // Enterprise mode: synthesize from GITHUB_ENTERPRISE + GITHUB_ORGS
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

  // Org-only mode: GITHUB_ORGS set without GITHUB_ENTERPRISE
  if (include.length > 0) {
    cachedEnterprises = [
      {
        slug: "_org_only",
        displayName: "Organizations",
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
        metrics: {
          copilot: { enterprise: false },
          billing: { enabled: false },
        },
      },
    ];
    cacheTimestamp = now;
    return cachedEnterprises;
  }

  cachedEnterprises = [];
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
/**
 * Returns client-safe enterprise list (no auth details). Safe to send in API responses.
 * Filters out the synthetic `_org_only` slug when it's the only entry,
 * since there's nothing to filter and it's not a real enterprise name.
 */
export function getClientEnterpriseList(): EnterpriseInfo[] {
  const enterprises = getConfiguredEnterprises();
  return enterprises
    .filter((e) => e.slug !== "_org_only")
    .map((e) => ({
      slug: e.slug,
      displayName: e.displayName,
    }));
}

/**
 * Resolve auth credentials for a specific enterprise by reading its env vars.
 * For org-only entries with app auth configured, the PAT is optional.
 */
export function getEnterpriseAuth(slug: string): EnterpriseAuth {
  const config = getEnterpriseConfig(slug);

  const token = process.env[config.tokenEnvVar] ?? "";

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

  // In org-only mode, PAT is optional when app auth is configured
  // (org endpoints use app auth; enterprise endpoints are never called)
  if (!token) {
    if (isOrgOnlyEnterprise(slug) && appConfig) {
      return { token: "", appConfig };
    }
    throw new Error(
      `PAT not found: environment variable "${config.tokenEnvVar}" is not set for enterprise "${slug}".`
    );
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
 * Returns true when the given enterprise entry is org-only (no enterprise-level access).
 * Org-only entries have `copilot.enterprise: false` in their metrics overrides,
 * or the global config has `copilot.enterprise: false` with no per-enterprise override.
 */
export function isOrgOnlyEnterprise(slug: string): boolean {
  try {
    // Check per-enterprise override first
    const entConfig = getEnterpriseConfig(slug);
    const override = entConfig.metrics?.copilot;
    if (override && typeof override.enterprise === "boolean") {
      return !override.enterprise;
    }
  } catch {
    // Unknown slug — not org-only
    return false;
  }

  // Fall back to global config
  try {
    const config = getDashboardConfig();
    const globalEnterprise = config.metrics?.copilot?.enterprise;
    // Default is true (enterprise enabled) when not specified
    return globalEnterprise === false;
  } catch {
    return false;
  }
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
    orgs = getDiscoveredOrgsFromDb(slug);
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
 * In org-only mode, defaults to the first resolved org.
 * In legacy mode, uses GITHUB_ENTERPRISE env var.
 * Falls back to the first resolved org if enterprise mode is off.
 */
export function resolveDefaultScope(): { scope: string; scopeId: string } {
  const enterprises = getConfiguredEnterprises();
  if (enterprises.length > 0) {
    const first = enterprises[0];
    // Org-only entries should default to org scope, not enterprise
    if (isOrgOnlyEnterprise(first.slug)) {
      const orgs = getResolvedOrgsForEnterprise(first.slug);
      if (orgs.length > 0) {
        return { scope: "org", scopeId: orgs[0] };
      }
      return { scope: "org", scopeId: "" };
    }
    return { scope: "enterprise", scopeId: first.slug };
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
  // Billing requires enterprise mode to be enabled (billing API is enterprise-only)
  if (!isCopilotSubEnabledForEnterprise(slug, "enterprise")) return false;
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
 * Falls back to global config when no enterprises are configured (legacy mode).
 * Used for page visibility — show a page if at least one enterprise has the sub-toggle enabled.
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
 * Falls back to global config when no enterprises are configured (legacy mode).
 * Used for page visibility — show a page if at least one enterprise has the sub-toggle enabled.
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
