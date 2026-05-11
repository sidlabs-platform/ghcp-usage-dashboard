// DB operations for enterprise_orgs table — caches auto-discovered and configured orgs

import { getDb } from "./database";

/**
 * Upsert a batch of orgs for an enterprise. Runs inside a transaction for performance.
 */
export function upsertEnterpriseOrgs(
  enterpriseSlug: string,
  orgSlugs: string[],
  source: "discovered" | "configured",
): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO enterprise_orgs (enterprise_slug, org_slug, source, last_synced_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(enterprise_slug, org_slug) DO UPDATE SET
       source = excluded.source,
       last_synced_at = excluded.last_synced_at`,
  );

  const tx = db.transaction(() => {
    for (const org of orgSlugs) {
      stmt.run(enterpriseSlug, org, source);
    }
  });
  tx();
}

/**
 * Return all cached org slugs for an enterprise.
 */
export function getEnterpriseOrgs(enterpriseSlug: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT org_slug FROM enterprise_orgs WHERE enterprise_slug = ? ORDER BY org_slug")
    .all(enterpriseSlug) as { org_slug: string }[];
  return rows.map((r) => r.org_slug);
}

/**
 * Remove orgs for an enterprise, optionally filtered by source.
 * Used to clear stale discovered orgs before re-populating.
 */
export function clearEnterpriseOrgs(
  enterpriseSlug: string,
  source?: "discovered" | "configured",
): void {
  const db = getDb();
  if (source) {
    db.prepare("DELETE FROM enterprise_orgs WHERE enterprise_slug = ? AND source = ?").run(
      enterpriseSlug,
      source,
    );
  } else {
    db.prepare("DELETE FROM enterprise_orgs WHERE enterprise_slug = ?").run(enterpriseSlug);
  }
}
