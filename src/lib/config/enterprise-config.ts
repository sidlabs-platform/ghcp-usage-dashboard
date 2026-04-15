// Multi-enterprise configuration — server-only + client-safe types & helpers

import { getDashboardConfig } from "./dashboard-config";

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

  // For multi-enterprise, orgs are defined per enterprise in config
  // For legacy mode, orgs come from GITHUB_ORGS env var (already in include via synthesis)
  let orgs = [...include];

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
