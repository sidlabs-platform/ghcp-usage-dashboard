/**
 * Lazy-loading bridge to orgs-repo DB access.
 *
 * Config modules cannot statically import orgs-repo because the DB layer
 * depends on config, creating a circular dependency.  This module
 * encapsulates the single lazy require() + error handling so that every
 * call-site doesn't have to duplicate it.
 */

/**
 * Return auto-discovered org slugs cached in the DB for the given enterprise.
 * Returns an empty array when the DB is not yet initialized.
 */
export function getDiscoveredOrgsFromDb(enterpriseSlug: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getEnterpriseOrgs } = require("@/lib/db/orgs-repo") as {
      getEnterpriseOrgs: (slug: string) => string[];
    };
    return getEnterpriseOrgs(enterpriseSlug);
  } catch {
    return [];
  }
}
