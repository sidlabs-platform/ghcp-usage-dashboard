// Enterprise context — bundles enterprise metadata + auth for sync & write operations

import {
  getEnterpriseConfig,
  getEnterpriseAuth,
  getConfiguredEnterprises,
  type EnterpriseConfig,
  type EnterpriseAuth,
} from "@/lib/config/enterprise-config";

export interface EnterpriseContext {
  /** Stable config slug — used as enterprise_slug in DB columns. */
  slug: string;
  /** Human-readable name for UI display. */
  displayName: string;
  /** GitHub's enterprise ID (from API data). Null until first sync populates enterprise_registry. */
  enterpriseId: string | null;
  /** Resolved auth credentials for this enterprise. */
  auth: EnterpriseAuth;
  /** Organization include/exclude config. */
  organizations: {
    include: string[];
    exclude: string[];
  };
}

/**
 * Create an EnterpriseContext for a specific enterprise slug.
 * Resolves auth from env vars and looks up enterprise_id from the registry.
 */
export function getEnterpriseContext(slug: string): EnterpriseContext {
  const config = getEnterpriseConfig(slug);
  const auth = getEnterpriseAuth(slug);

  // Try to resolve enterprise_id from the enterprise_registry table
  let enterpriseId: string | null = null;
  try {
    // Dynamic import to avoid circular dependency with database.ts
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db/database");
    const db = getDb();
    const row = db.prepare("SELECT enterprise_id FROM enterprise_registry WHERE slug = ?").get(slug) as { enterprise_id: string | null } | undefined;
    enterpriseId = row?.enterprise_id ?? null;
  } catch {
    // DB may not be initialized yet — that's fine, enterpriseId will be null
  }

  return {
    slug,
    displayName: config.displayName,
    enterpriseId,
    auth,
    organizations: {
      include: config.organizations?.include ?? [],
      exclude: config.organizations?.exclude ?? [],
    },
  };
}

/**
 * Create EnterpriseContext for all configured enterprises.
 */
export function getAllEnterpriseContexts(): EnterpriseContext[] {
  return getConfiguredEnterprises().map((e) => getEnterpriseContext(e.slug));
}

/**
 * Upsert the enterprise_registry row after we learn the GitHub enterprise_id from API data.
 * Called during sync when we get enterprise data back from GitHub.
 */
export function updateEnterpriseRegistry(
  slug: string,
  enterpriseId: string,
  displayName?: string,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db/database");
    const db = getDb();
    db.prepare(
      `INSERT INTO enterprise_registry (slug, enterprise_id, display_name, last_synced_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET
         enterprise_id = excluded.enterprise_id,
         display_name = COALESCE(excluded.display_name, display_name),
         last_synced_at = excluded.last_synced_at`
    ).run(slug, enterpriseId, displayName ?? slug);
  } catch (err) {
    console.warn(`[Enterprise] Failed to update registry for "${slug}":`, err);
  }
}
