// GHAS Sync Service — fetches security alerts from GitHub Advanced Security APIs
// Supports incremental sync via per-scope/per-category sync state tracking

import { codeScanningClient } from "@/lib/github/code-scanning-client";
import { dependabotClient } from "@/lib/github/dependabot-client";
import { secretScanningClient } from "@/lib/github/secret-scanning-client";
import {
  upsertCodeScanningAlerts,
  upsertDependabotAlerts,
  upsertSecretScanningAlerts,
  recomputeCodeScanningDaily,
  recomputeDependabotDaily,
  recomputeSecretScanningDaily,
  getGhasSyncState,
  updateGhasSyncState,
} from "./ghas-repo";
import { getDb } from "./database";
import { isMetricEnabled, getSecurityConfig, isEnterpriseEnabled, getResolvedOrgs } from "@/lib/config/dashboard-config";

// ── Helpers ───────────────────────────────────────────────────────────

/** Returns the enterprise slug, or null when enterprise mode is disabled. */
function getEnterprise(): string | null {
  if (!isEnterpriseEnabled()) return null;
  return process.env.GITHUB_ENTERPRISE || null;
}

function getOrgs(): string[] {
  return getResolvedOrgs();
}

// ── Progress type ─────────────────────────────────────────────────────

export interface GhasSyncProgress {
  phase: string;
  category?: string;
  current: number;
  total: number;
  message: string;
}

// ── Sync a single category for a single scope ────────────────────────

async function syncCategory(
  scope: "enterprise" | "org",
  scopeId: string,
  category: "code_scanning" | "dependabot" | "secret_scanning",
  onProgress?: (p: GhasSyncProgress) => void
): Promise<{ alertsFetched: number; isIncremental: boolean }> {
  const configKey = category === "code_scanning" ? "codeScanning"
    : category === "secret_scanning" ? "secretScanning"
    : "dependabot";

  if (!isMetricEnabled(configKey as any)) {
    return { alertsFetched: 0, isIncremental: false };
  }

  // Determine cutoff from previous sync state
  const syncState = getGhasSyncState(scope, scopeId, category);
  let cutoffDate = syncState?.last_alert_updated_at || null;
  const isIncremental = !!cutoffDate;

  // On first sync, use backfillDays to limit how far back we fetch
  if (!cutoffDate) {
    const { backfillDays } = getSecurityConfig();
    const cutoffTime = new Date();
    cutoffTime.setDate(cutoffTime.getDate() - backfillDays);
    cutoffDate = cutoffTime.toISOString();
  }

  // Add safety overlap: go back 1 hour from last sync to catch page-boundary drift
  if (isIncremental) {
    const overlap = new Date(cutoffDate);
    overlap.setHours(overlap.getHours() - 1);
    cutoffDate = overlap.toISOString();
  }

  onProgress?.({
    phase: "ghas-sync",
    category,
    current: 0,
    total: 1,
    message: `${isIncremental ? "Incremental" : "Full"} sync: ${category} for ${scope}/${scopeId}`,
  });

  // Mark syncing
  updateGhasSyncState(
    scope, scopeId, category,
    new Date().toISOString(), cutoffDate,
    syncState?.total_alerts || 0, "syncing"
  );

  try {
    let alerts: any[];

    if (category === "code_scanning") {
      alerts = scope === "enterprise"
        ? await codeScanningClient.getEnterpriseAlerts(scopeId, cutoffDate)
        : await codeScanningClient.getOrgAlerts(scopeId, cutoffDate);
      upsertCodeScanningAlerts(scope, scopeId, alerts);
      recomputeCodeScanningDaily(scope, scopeId);
    } else if (category === "dependabot") {
      alerts = scope === "enterprise"
        ? await dependabotClient.getEnterpriseAlerts(scopeId, cutoffDate)
        : await dependabotClient.getOrgAlerts(scopeId, cutoffDate);
      upsertDependabotAlerts(scope, scopeId, alerts);
      recomputeDependabotDaily(scope, scopeId);
    } else {
      alerts = scope === "enterprise"
        ? await secretScanningClient.getEnterpriseAlerts(scopeId, cutoffDate)
        : await secretScanningClient.getOrgAlerts(scopeId, cutoffDate);
      upsertSecretScanningAlerts(scope, scopeId, alerts);
      recomputeSecretScanningDaily(scope, scopeId);
    }

    // Find latest updated_at from fetched alerts
    const latestUpdatedAt = alerts.length > 0
      ? alerts.reduce((max, a) => (a.updated_at > max ? a.updated_at : max), alerts[0].updated_at)
      : syncState?.last_alert_updated_at || null;

    // Count actual alerts in DB for this scope (accurate after upsert)
    const db = getDb();
    const table = category === "code_scanning" ? "ghas_code_scanning_alerts"
      : category === "dependabot" ? "ghas_dependabot_alerts"
      : "ghas_secret_scanning_alerts";
    const totalAlerts = (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE scope = ? AND scope_id = ?`).get(scope, scopeId) as { cnt: number }).cnt;

    updateGhasSyncState(
      scope, scopeId, category,
      new Date().toISOString(), latestUpdatedAt,
      totalAlerts,
      "ok"
    );

    onProgress?.({
      phase: "ghas-sync",
      category,
      current: 1,
      total: 1,
      message: `Synced ${alerts.length} ${category} alerts for ${scope}/${scopeId}`,
    });

    return { alertsFetched: alerts.length, isIncremental };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GHAS Sync] Failed ${category} for ${scope}/${scopeId}:`, msg);
    updateGhasSyncState(
      scope, scopeId, category,
      new Date().toISOString(), cutoffDate,
      syncState?.total_alerts || 0, "error", msg
    );
    return { alertsFetched: 0, isIncremental };
  }
}

// ── Full GHAS sync (all categories, all scopes) ──────────────────────

export async function fullGhasSync(
  onProgress?: (p: GhasSyncProgress) => void
): Promise<{
  categories: Record<string, { alertsFetched: number; isIncremental: boolean }>;
  errors: number;
}> {
  const enterprise = getEnterprise();
  const orgs = getOrgs();
  const categories = ["code_scanning", "dependabot", "secret_scanning"] as const;
  const results: Record<string, { alertsFetched: number; isIncremental: boolean }> = {};
  let errors = 0;

  // Sync enterprise-level (only when enterprise mode is on)
  if (enterprise) {
    for (const category of categories) {
      try {
        const key = `enterprise:${enterprise}:${category}`;
        results[key] = await syncCategory("enterprise", enterprise, category, onProgress);
      } catch (err) {
        errors++;
        console.error(`[GHAS Sync] Enterprise ${category} failed:`, err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Sync org-level
  for (const org of orgs) {
    for (const category of categories) {
      try {
        const key = `org:${org}:${category}`;
        results[key] = await syncCategory("org", org, category, onProgress);
      } catch (err) {
        errors++;
        console.error(`[GHAS Sync] Org ${org} ${category} failed:`, err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return { categories: results, errors };
}

// ── Incremental GHAS sync ─────────────────────────────────────────────
// The syncCategory function automatically does incremental sync when
// prior sync state exists, so this delegates to fullGhasSync.

export async function incrementalGhasSync(
  onProgress?: (p: GhasSyncProgress) => void
): Promise<{
  categories: Record<string, { alertsFetched: number; isIncremental: boolean }>;
  errors: number;
}> {
  return fullGhasSync(onProgress);
}
