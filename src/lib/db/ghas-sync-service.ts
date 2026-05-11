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
  updateAlertAutofixStatuses,
  promoteAutofixCommitted,
  getOpenCodeScanningAlerts,
} from "./ghas-repo";
import { getDb } from "./database";
import { getSecurityConfig } from "@/lib/config/dashboard-config";
import {
  getConfiguredEnterprises, getResolvedOrgsForEnterprise,
  isMetricEnabledForEnterprise, isCopilotSubEnabledForEnterprise,
  isCodeScanningAutofixEnabledForEnterprise,
} from "@/lib/config/enterprise-config";
import type { MetricCategory } from "@/lib/config/dashboard-config";
import type { AutofixStatusResponse } from "@/lib/github/code-scanning-client";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Map GitHub autofix API status to our internal status.
 * "success" / "outdated" → "available"; anything else → "none"
 */
function mapAutofixStatus(resp: AutofixStatusResponse | null): string {
  if (!resp) return "none";
  if (resp.status === "success" || resp.status === "outdated") return "available";
  return "none";
}

const AUTOFIX_CONCURRENCY = 10;

/**
 * Enrich open code scanning alerts with autofix status.
 * Makes one API call per open alert (concurrency-limited).
 */
async function enrichAutofixStatuses(
  enterpriseSlug: string,
  scope: string,
  scopeId: string,
  onProgress?: (p: GhasSyncProgress) => void,
): Promise<number> {
  const openAlerts = getOpenCodeScanningAlerts(scope, scopeId, [enterpriseSlug]);
  if (openAlerts.length === 0) return 0;

  onProgress?.({
    phase: "ghas-sync",
    category: "code_scanning_autofix",
    enterpriseSlug,
    current: 0,
    total: openAlerts.length,
    message: `Fetching autofix status for ${openAlerts.length} open alerts in ${scope}/${scopeId}`,
  });

  const updates: { alertNumber: number; repoFullName: string; autofixStatus: string }[] = [];
  let completed = 0;

  // Process in batches with concurrency limit
  for (let i = 0; i < openAlerts.length; i += AUTOFIX_CONCURRENCY) {
    const batch = openAlerts.slice(i, i + AUTOFIX_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (alert) => {
        const parts = alert.repo_full_name.split("/");
        if (parts.length < 2) return null;
        const [owner, repo] = parts;
        const resp = await codeScanningClient.getAlertAutofixStatus(owner, repo, alert.alert_number, enterpriseSlug);
        return {
          alertNumber: alert.alert_number,
          repoFullName: alert.repo_full_name,
          autofixStatus: mapAutofixStatus(resp),
        };
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        updates.push(r.value);
      } else if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`[Autofix] API error during enrichment: ${msg}`);
      }
    }

    completed += batch.length;
    onProgress?.({
      phase: "ghas-sync",
      category: "code_scanning_autofix",
      enterpriseSlug,
      current: Math.min(completed, openAlerts.length),
      total: openAlerts.length,
      message: `Autofix status: ${completed}/${openAlerts.length} alerts checked`,
    });
  }

  if (updates.length > 0) {
    updateAlertAutofixStatuses(enterpriseSlug, scope, scopeId, updates);
  }

  return updates.filter(u => u.autofixStatus !== "none").length;
}

// ── Progress type ─────────────────────────────────────────────────────

export interface GhasSyncProgress {
  phase: string;
  category?: string;
  enterpriseSlug?: string;
  current: number;
  total: number;
  message: string;
}

// ── Sync a single category for a single scope ────────────────────────

async function syncCategory(
  enterpriseSlug: string,
  scope: "enterprise" | "org",
  scopeId: string,
  category: "code_scanning" | "dependabot" | "secret_scanning",
  onProgress?: (p: GhasSyncProgress) => void
): Promise<{ alertsFetched: number; isIncremental: boolean }> {
  const configKey = category === "code_scanning" ? "codeScanning"
    : category === "secret_scanning" ? "secretScanning"
    : "dependabot";

  if (!isMetricEnabledForEnterprise(enterpriseSlug, configKey as MetricCategory)) {
    return { alertsFetched: 0, isIncremental: false };
  }

  // Determine cutoff from previous sync state
  const syncState = getGhasSyncState(scope, scopeId, category, [enterpriseSlug]);
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
    enterpriseSlug,
    current: 0,
    total: 1,
    message: `${isIncremental ? "Incremental" : "Full"} sync: ${category} for ${scope}/${scopeId}`,
  });

  // Mark syncing
  updateGhasSyncState(
    enterpriseSlug, scope, scopeId, category,
    new Date().toISOString(), cutoffDate,
    syncState?.total_alerts || 0, "syncing"
  );

  try {
    let alerts: any[];

    if (category === "code_scanning") {
      alerts = scope === "enterprise"
        ? await codeScanningClient.getEnterpriseAlerts(scopeId, cutoffDate, enterpriseSlug)
        : await codeScanningClient.getOrgAlerts(scopeId, cutoffDate, enterpriseSlug);
      upsertCodeScanningAlerts(enterpriseSlug, scope, scopeId, alerts);

      // Enrich with autofix status if enabled (optional, per-alert API calls)
      if (isCodeScanningAutofixEnabledForEnterprise(enterpriseSlug)) {
        await enrichAutofixStatuses(enterpriseSlug, scope, scopeId, onProgress);
        // Promote fixed alerts that had autofix available → committed
        promoteAutofixCommitted(enterpriseSlug, scope, scopeId);
      }

      recomputeCodeScanningDaily(enterpriseSlug, scope, scopeId);
    } else if (category === "dependabot") {
      alerts = scope === "enterprise"
        ? await dependabotClient.getEnterpriseAlerts(scopeId, cutoffDate, enterpriseSlug)
        : await dependabotClient.getOrgAlerts(scopeId, cutoffDate, enterpriseSlug);
      upsertDependabotAlerts(enterpriseSlug, scope, scopeId, alerts);
      recomputeDependabotDaily(enterpriseSlug, scope, scopeId);
    } else {
      alerts = scope === "enterprise"
        ? await secretScanningClient.getEnterpriseAlerts(scopeId, cutoffDate, enterpriseSlug)
        : await secretScanningClient.getOrgAlerts(scopeId, cutoffDate, enterpriseSlug);
      upsertSecretScanningAlerts(enterpriseSlug, scope, scopeId, alerts);
      recomputeSecretScanningDaily(enterpriseSlug, scope, scopeId);
    }

    // Find latest updated_at from fetched alerts
    const latestUpdatedAt = alerts.length > 0
      ? alerts.reduce((max, a) => (a.updated_at > max ? a.updated_at : max), alerts[0].updated_at)
      : syncState?.last_alert_updated_at || null;

    // Count actual alerts in DB for this scope (accurate after upsert)
    // Use explicit SQL per category to avoid table name interpolation (security best practice)
    const db = getDb();
    let totalAlerts: number;
    switch (category) {
      case "code_scanning":
        totalAlerts = (db.prepare(`SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ?`).get(scope, scopeId) as { cnt: number }).cnt;
        break;
      case "dependabot":
        totalAlerts = (db.prepare(`SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ?`).get(scope, scopeId) as { cnt: number }).cnt;
        break;
      case "secret_scanning":
        totalAlerts = (db.prepare(`SELECT COUNT(*) as cnt FROM ghas_secret_scanning_alerts WHERE scope = ? AND scope_id = ?`).get(scope, scopeId) as { cnt: number }).cnt;
        break;
      default: {
        const _exhaustive: never = category;
        throw new Error(`Unknown GHAS category: ${_exhaustive}`);
      }
    }

    updateGhasSyncState(
      enterpriseSlug, scope, scopeId, category,
      new Date().toISOString(), latestUpdatedAt,
      totalAlerts,
      "ok"
    );

    onProgress?.({
      phase: "ghas-sync",
      category,
      enterpriseSlug,
      current: 1,
      total: 1,
      message: `Synced ${alerts.length} ${category} alerts for ${scope}/${scopeId}`,
    });

    return { alertsFetched: alerts.length, isIncremental };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GHAS Sync] Failed ${category} for ${scope}/${scopeId}:`, msg);
    updateGhasSyncState(
      enterpriseSlug, scope, scopeId, category,
      new Date().toISOString(), cutoffDate,
      syncState?.total_alerts || 0, "error", msg
    );
    return { alertsFetched: 0, isIncremental };
  }
}

// ── Full GHAS sync (all categories, all scopes) ──────────────────────

async function syncGhasForEnterprise(
  enterpriseSlug: string,
  onProgress?: (p: GhasSyncProgress) => void,
): Promise<{
  results: Record<string, { alertsFetched: number; isIncremental: boolean }>;
  errors: number;
}> {
  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);
  const categories = ["code_scanning", "dependabot", "secret_scanning"] as const;
  const results: Record<string, { alertsFetched: number; isIncremental: boolean }> = {};
  let errors = 0;

  // Sync enterprise-level (only when enterprise mode is on)
  if (isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise")) {
    for (const category of categories) {
      try {
        const key = `enterprise:${enterpriseSlug}:${category}`;
        results[key] = await syncCategory(enterpriseSlug, "enterprise", enterpriseSlug, category, onProgress);
      } catch (err) {
        errors++;
        console.error(`[GHAS Sync] Enterprise ${enterpriseSlug} ${category} failed:`, err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Sync org-level
  for (const org of orgs) {
    for (const category of categories) {
      try {
        const key = `org:${org}:${category}`;
        results[key] = await syncCategory(enterpriseSlug, "org", org, category, onProgress);
      } catch (err) {
        errors++;
        console.error(`[GHAS Sync] Org ${org} ${category} failed:`, err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return { results, errors };
}

export async function fullGhasSync(
  onProgress?: (p: GhasSyncProgress) => void,
  enterpriseSlug?: string,
): Promise<{
  categories: Record<string, { alertsFetched: number; isIncremental: boolean }>;
  errors: number;
}> {
  const allResults: Record<string, { alertsFetched: number; isIncremental: boolean }> = {};
  let totalErrors = 0;

  const slugs = enterpriseSlug
    ? [enterpriseSlug]
    : getConfiguredEnterprises().map(e => e.slug);

  for (const slug of slugs) {
    const { results, errors } = await syncGhasForEnterprise(slug, onProgress);
    Object.assign(allResults, results);
    totalErrors += errors;
  }

  return { categories: allResults, errors: totalErrors };
}

// ── Incremental GHAS sync ─────────────────────────────────────────────
// The syncCategory function automatically does incremental sync when
// prior sync state exists, so this delegates to fullGhasSync.

export async function incrementalGhasSync(
  onProgress?: (p: GhasSyncProgress) => void,
  enterpriseSlug?: string,
): Promise<{
  categories: Record<string, { alertsFetched: number; isIncremental: boolean }>;
  errors: number;
}> {
  return fullGhasSync(onProgress, enterpriseSlug);
}
