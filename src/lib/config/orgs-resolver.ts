/**
 * Lazy-loading bridge to orgs-repo DB access.
 *
 * Config modules cannot statically import orgs-repo because the DB layer
 * depends on config, creating a circular dependency.  This module
 * encapsulates the single lazy require() + error handling so that every
 * call-site doesn't have to duplicate it.
 */

type OrgsLoader = (slug: string) => string[];

let _loader: OrgsLoader | undefined;

function ensureLoader(): OrgsLoader {
  if (!_loader) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../db/orgs-repo") as { getEnterpriseOrgs: OrgsLoader };
    _loader = mod.getEnterpriseOrgs;
  }
  return _loader;
}

/** @internal Reset or override the loader — for testing only. */
export function _resetLoader(override?: OrgsLoader): void {
  _loader = override;
}

/**
 * Return auto-discovered org slugs cached in the DB for the given enterprise.
 * Returns an empty array when the DB is not yet initialized.
 */
export function getDiscoveredOrgsFromDb(enterpriseSlug: string): string[] {
  try {
    return ensureLoader()(enterpriseSlug);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn("[orgs-resolver] Failed to load orgs from DB, returning empty:",
        err instanceof Error ? err.message : err);
    }
    _loader = undefined;
    return [];
  }
}
