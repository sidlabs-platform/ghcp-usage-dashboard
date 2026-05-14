// GitHub App authentication — JWT signing + installation token management
// Uses `jose` for RS256 JWT generation (Edge-compatible, zero deps)

import { SignJWT, importPKCS8 } from "jose";

const GITHUB_API_BASE =
  process.env.GITHUB_API_BASE || "https://api.github.com";
const API_VERSION = "2026-03-10";

// ── Configuration ─────────────────────────────────────────────────────

interface AppConfig {
  appId: string;
  privateKey: string; // PEM content (newlines normalized)
  installationId: string;
}

function loadAppConfig(): AppConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (!appId || !rawKey || !installationId) return null;

  // Normalize PEM: env vars often use literal "\n" instead of real newlines
  const privateKey = rawKey.replace(/\\n/g, "\n");

  return { appId, privateKey, installationId };
}

let _appConfig: AppConfig | null | undefined;

function getAppConfig(): AppConfig | null {
  if (_appConfig === undefined) {
    _appConfig = loadAppConfig();
  }
  return _appConfig;
}

/** Returns true when all 3 GitHub App env vars are set. */
export function isAppAuthConfigured(): boolean {
  return getAppConfig() !== null;
}

/**
 * Load App config for a specific enterprise.
 * Returns null if the enterprise has no App auth configured.
 */
export function loadAppConfigForEnterprise(
  enterpriseSlug: string
): AppConfig | null {
  try {
    const loader = _enterpriseAuthFn ?? (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("@/lib/config/enterprise-config") as {
        getEnterpriseAuth: (slug: string) => {
          appConfig?: { appId: string; privateKey: string; installationId: string };
        };
      };
      return mod.getEnterpriseAuth;
    })();
    const auth = loader(enterpriseSlug);
    if (!auth.appConfig) return null;
    return {
      appId: auth.appConfig.appId,
      privateKey: auth.appConfig.privateKey,
      installationId: auth.appConfig.installationId,
    };
  } catch {
    return null;
  }
}

type EnterpriseAuthFn = (slug: string) => {
  appConfig?: { appId: string; privateKey: string; installationId: string };
};
let _enterpriseAuthFn: EnterpriseAuthFn | undefined;

/** @internal Override the enterprise auth loader — for testing only. */
export function _setEnterpriseAuthFn(fn?: EnterpriseAuthFn): void {
  _enterpriseAuthFn = fn;
}

/** Returns true when the given enterprise has App auth configured. */
export function isAppAuthConfiguredForEnterprise(
  enterpriseSlug: string
): boolean {
  return loadAppConfigForEnterprise(enterpriseSlug) !== null;
}

// ── JWT Generation ────────────────────────────────────────────────────

async function generateJWT(config: AppConfig): Promise<string> {
  const key = await importPKCS8(config.privateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.appId)
    .setIssuedAt(now - 60) // 60s clock skew allowance
    .setExpirationTime(now + 10 * 60) // 10 min max per GitHub docs
    .sign(key);
}

// ── Installation Token Management ─────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp in ms
}

const SAFETY_MARGIN_MS = 2 * 60 * 1000; // Refresh 2 min before expiry

let cachedToken: CachedToken | null = null;
let refreshPromise: Promise<string> | null = null;
let validated = false;

// Per-enterprise token caches
const tokenCache = new Map<string, CachedToken>();
const refreshPromises = new Map<string, Promise<string>>();

function isTokenValid(): boolean {
  return cachedToken !== null && Date.now() < cachedToken.expiresAt - SAFETY_MARGIN_MS;
}

async function mintInstallationToken(config: AppConfig): Promise<CachedToken> {
  const jwt = await generateJWT(config);

  const url = `${GITHUB_API_BASE}/app/installations/${config.installationId}/access_tokens`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Failed to create installation token: HTTP ${resp.status} — ${body}`
    );
  }

  const data = (await resp.json()) as { token?: string; expires_at?: string };

  if (!data.token || !data.expires_at) {
    throw new Error(
      `Invalid installation token response: missing token or expires_at`
    );
  }

  const expiresAt = new Date(data.expires_at).getTime();
  if (Number.isNaN(expiresAt)) {
    throw new Error(
      `Invalid installation token response: unparseable expires_at "${data.expires_at}"`
    );
  }

  return {
    token: data.token,
    expiresAt,
  };
}

/**
 * Returns a valid GitHub App installation access token.
 * Caches until near-expiry and uses mutex to prevent concurrent minting.
 * Throws if App auth is not configured or token generation fails (fail-fast).
 */
export async function getInstallationToken(): Promise<string> {
  const config = getAppConfig();
  if (!config) {
    throw new Error(
      "GitHub App auth is not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID."
    );
  }

  if (isTokenValid()) {
    return cachedToken!.token;
  }

  // Mutex: if refresh already in-flight, await the same promise
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      cachedToken = await mintInstallationToken(config);
      return cachedToken.token;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Get installation token for a specific enterprise.
 * Caches per enterprise slug with mutex to prevent concurrent minting.
 */
export async function getInstallationTokenForEnterprise(
  enterpriseSlug: string
): Promise<string> {
  const config = loadAppConfigForEnterprise(enterpriseSlug);
  if (!config) {
    throw new Error(
      `GitHub App auth not configured for enterprise "${enterpriseSlug}".`
    );
  }

  const cached = tokenCache.get(enterpriseSlug);
  if (cached && Date.now() < cached.expiresAt - SAFETY_MARGIN_MS) {
    return cached.token;
  }

  const existing = refreshPromises.get(enterpriseSlug);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await mintInstallationToken(config);
      tokenCache.set(enterpriseSlug, result);
      return result.token;
    } finally {
      refreshPromises.delete(enterpriseSlug);
    }
  })();

  refreshPromises.set(enterpriseSlug, promise);
  return promise;
}

// ── Startup Validation────────────────────────────────────────────────

/**
 * Eagerly validate App auth on first use. Attempts to mint a token and throws
 * with a clear error if it fails. Does not silently fall back to PAT.
 */
export async function validateAppAuth(): Promise<void> {
  if (validated) return;

  const config = getAppConfig();
  if (!config) return; // App auth not configured — nothing to validate

  try {
    await getInstallationToken();
    validated = true;
    console.log(
      `[Auth] GitHub App auth validated (App ID: ${config.appId}, Installation: ${config.installationId})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[Auth] GitHub App auth validation failed — check GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID. Error: ${msg}`
    );
  }
}

/**
 * Log which auth mode is active. Called once on first API call.
 */
export function logAuthMode(): void {
  if (isAppAuthConfigured()) {
    const config = getAppConfig()!;
    console.log(
      `[Auth] GitHub App auth active for org/repo endpoints (App ID: ${config.appId}). PAT used for enterprise endpoints.`
    );
  } else {
    console.log("[Auth] PAT auth for all endpoints (no GitHub App configured)");
  }
}
