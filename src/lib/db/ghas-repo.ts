// GHAS repository — CRUD for security alert caches, daily aggregates, and sync state

import { getDb } from "./database";
import type {
  CodeScanningAlert,
  DependabotAlert,
  SecretScanningAlert,
  CodeScanningDaily,
  DependabotDaily,
  SecretScanningDaily,
  GhasSyncState,
  SecurityOverview,
} from "@/lib/types/ghas";

// ── Alert Cache Operations ────────────────────────────────────────────

export function upsertCodeScanningAlerts(
  scope: string,
  scopeId: string,
  alerts: CodeScanningAlert[]
): void {
  const db = getDb();
  // Use ON CONFLICT to preserve existing autofix_status when the list API doesn't provide it
  const stmt = db.prepare(`
    INSERT INTO ghas_code_scanning_alerts
      (scope, scope_id, alert_number, repo_full_name, state, severity, rule_id, tool_name,
       created_at, updated_at, fixed_at, dismissed_at, dismissed_reason, autofix_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, scope_id, alert_number, repo_full_name) DO UPDATE SET
      state = excluded.state,
      severity = excluded.severity,
      rule_id = excluded.rule_id,
      tool_name = excluded.tool_name,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      fixed_at = excluded.fixed_at,
      dismissed_at = excluded.dismissed_at,
      dismissed_reason = excluded.dismissed_reason,
      autofix_status = CASE
        WHEN excluded.autofix_status != 'none' THEN excluded.autofix_status
        ELSE ghas_code_scanning_alerts.autofix_status
      END
  `);
  const tx = db.transaction(() => {
    for (const a of alerts) {
      stmt.run(
        scope,
        scopeId,
        a.number,
        a.repository?.full_name || "unknown",
        a.state,
        a.rule.security_severity_level || a.rule.severity || null,
        a.rule.id,
        a.tool.name,
        a.created_at,
        a.updated_at,
        a.fixed_at,
        a.dismissed_at,
        a.dismissed_reason,
        a.autofix?.status || "none"
      );
    }
  });
  tx();
}

/**
 * Batch-update autofix_status for code scanning alerts from API responses.
 */
export function updateAlertAutofixStatuses(
  scope: string,
  scopeId: string,
  updates: { alertNumber: number; repoFullName: string; autofixStatus: string }[]
): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE ghas_code_scanning_alerts
    SET autofix_status = ?
    WHERE scope = ? AND scope_id = ? AND alert_number = ? AND repo_full_name = ?
  `);
  const tx = db.transaction(() => {
    for (const u of updates) {
      stmt.run(u.autofixStatus, scope, scopeId, u.alertNumber, u.repoFullName);
    }
  });
  tx();
}

/**
 * Promote autofix_status from "available" to "committed" for alerts that have been fixed.
 * This is a heuristic: if an alert was fixed and had autofix available, we assume the autofix was applied.
 */
export function promoteAutofixCommitted(scope: string, scopeId: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE ghas_code_scanning_alerts
    SET autofix_status = 'committed'
    WHERE scope = ? AND scope_id = ?
      AND state = 'fixed'
      AND autofix_status = 'available'
  `).run(scope, scopeId);
  return result.changes;
}

/**
 * Get open code scanning alerts for a given scope, for autofix enrichment.
 */
export function getOpenCodeScanningAlerts(
  scope: string,
  scopeId: string,
): { alert_number: number; repo_full_name: string; state: string }[] {
  const db = getDb();
  return db.prepare(
    `SELECT alert_number, repo_full_name, state FROM ghas_code_scanning_alerts
     WHERE scope = ? AND scope_id = ? AND state = 'open'`
  ).all(scope, scopeId) as { alert_number: number; repo_full_name: string; state: string }[];
}

export function upsertDependabotAlerts(
  scope: string,
  scopeId: string,
  alerts: DependabotAlert[]
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ghas_dependabot_alerts
      (scope, scope_id, alert_number, repo_full_name, state, severity, ecosystem, package_name,
       created_at, updated_at, fixed_at, dismissed_at, dismissed_reason, auto_dismissed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const a of alerts) {
      stmt.run(
        scope,
        scopeId,
        a.number,
        a.repository?.full_name || "unknown",
        a.state,
        a.security_vulnerability.severity,
        a.security_vulnerability.package.ecosystem,
        a.security_vulnerability.package.name,
        a.created_at,
        a.updated_at,
        a.fixed_at,
        a.dismissed_at,
        a.dismissed_reason,
        a.auto_dismissed_at
      );
    }
  });
  tx();
}

export function upsertSecretScanningAlerts(
  scope: string,
  scopeId: string,
  alerts: SecretScanningAlert[]
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ghas_secret_scanning_alerts
      (scope, scope_id, alert_number, repo_full_name, state, secret_type, secret_type_display_name,
       created_at, updated_at, resolved_at, resolution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const a of alerts) {
      stmt.run(
        scope,
        scopeId,
        a.number,
        a.repository?.full_name || "unknown",
        a.state,
        a.secret_type,
        a.secret_type_display_name,
        a.created_at,
        a.updated_at,
        a.resolved_at,
        a.resolution
      );
    }
  });
  tx();
}

// ── Daily Aggregate Recomputation (from alert cache) ──────────────────

export function recomputeCodeScanningDaily(scope: string, scopeId: string): void {
  const db = getDb();

  db.prepare(`DELETE FROM ghas_code_scanning_daily WHERE scope = ? AND scope_id = ?`).run(scope, scopeId);

  const openedByDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as cnt
    FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ?
    GROUP BY date(created_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const fixedByDay = db.prepare(`
    SELECT date(fixed_at) as day, COUNT(*) as cnt
    FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND fixed_at IS NOT NULL
    GROUP BY date(fixed_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const dismissedByDay = db.prepare(`
    SELECT date(dismissed_at) as day, COUNT(*) as cnt
    FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND dismissed_at IS NOT NULL
    GROUP BY date(dismissed_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const allDays = new Set<string>();
  for (const r of openedByDay) allDays.add(r.day);
  for (const r of fixedByDay) allDays.add(r.day);
  for (const r of dismissedByDay) allDays.add(r.day);

  if (allDays.size === 0) return;

  const openedMap = new Map(openedByDay.map((r) => [r.day, r.cnt]));
  const fixedMap = new Map(fixedByDay.map((r) => [r.day, r.cnt]));
  const dismissedMap = new Map(dismissedByDay.map((r) => [r.day, r.cnt]));

  // Per-day severity counts: alerts open on that day = created on or before, not yet fixed/dismissed
  const severityByDayStmt = db.prepare(`
    SELECT COALESCE(severity, 'low') as severity, COUNT(*) as cnt
    FROM ghas_code_scanning_alerts
    WHERE scope = ? AND scope_id = ?
      AND date(created_at) <= ?
      AND (fixed_at IS NULL OR date(fixed_at) > ?)
      AND (dismissed_at IS NULL OR date(dismissed_at) > ?)
    GROUP BY COALESCE(severity, 'low')
  `);

  // Per-day autofix counts: among alerts that exist on that day
  const autofixByDayStmt = db.prepare(`
    SELECT
      SUM(CASE WHEN autofix_status IN ('available', 'committed') THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN autofix_status = 'committed' THEN 1 ELSE 0 END) as committed
    FROM ghas_code_scanning_alerts
    WHERE scope = ? AND scope_id = ?
      AND date(created_at) <= ?
  `);

  const sortedDays = Array.from(allDays).sort();
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO ghas_code_scanning_daily
      (day, scope, scope_id, opened, fixed, dismissed, reopened, total_open,
       severity_critical, severity_high, severity_medium, severity_low,
       autofix_available, autofix_committed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let runningOpen = 0;
  const tx = db.transaction(() => {
    for (const day of sortedDays) {
      const opened = openedMap.get(day) || 0;
      const fixed = fixedMap.get(day) || 0;
      const dismissed = dismissedMap.get(day) || 0;
      runningOpen += opened - fixed - dismissed;

      // Severity snapshot for this day
      const sevRows = severityByDayStmt.all(scope, scopeId, day, day, day) as { severity: string; cnt: number }[];
      const sevMap: Record<string, number> = {};
      for (const r of sevRows) sevMap[r.severity] = r.cnt;

      // Autofix snapshot
      const autofix = autofixByDayStmt.get(scope, scopeId, day) as { available: number; committed: number } | undefined;

      insertStmt.run(
        day, scope, scopeId, opened, fixed, dismissed, 0, Math.max(0, runningOpen),
        sevMap["critical"] || 0, sevMap["high"] || 0, sevMap["medium"] || 0, sevMap["low"] || 0,
        autofix?.available || 0, autofix?.committed || 0
      );
    }
  });
  tx();
}

export function recomputeDependabotDaily(scope: string, scopeId: string): void {
  const db = getDb();

  db.prepare(`DELETE FROM ghas_dependabot_daily WHERE scope = ? AND scope_id = ?`).run(scope, scopeId);

  const openedByDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as cnt
    FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ?
    GROUP BY date(created_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const fixedByDay = db.prepare(`
    SELECT date(fixed_at) as day, COUNT(*) as cnt
    FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND fixed_at IS NOT NULL
    GROUP BY date(fixed_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const dismissedByDay = db.prepare(`
    SELECT date(dismissed_at) as day, COUNT(*) as cnt
    FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND dismissed_at IS NOT NULL
    GROUP BY date(dismissed_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const autoDismissedByDay = db.prepare(`
    SELECT date(auto_dismissed_at) as day, COUNT(*) as cnt
    FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND auto_dismissed_at IS NOT NULL
    GROUP BY date(auto_dismissed_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const allDays = new Set<string>();
  for (const r of openedByDay) allDays.add(r.day);
  for (const r of fixedByDay) allDays.add(r.day);
  for (const r of dismissedByDay) allDays.add(r.day);
  for (const r of autoDismissedByDay) allDays.add(r.day);

  if (allDays.size === 0) return;

  const openedMap = new Map(openedByDay.map((r) => [r.day, r.cnt]));
  const fixedMap = new Map(fixedByDay.map((r) => [r.day, r.cnt]));
  const dismissedMap = new Map(dismissedByDay.map((r) => [r.day, r.cnt]));
  const autoDismissedMap = new Map(autoDismissedByDay.map((r) => [r.day, r.cnt]));

  // Per-day severity snapshot: alerts open on that day
  const severityByDayStmt = db.prepare(`
    SELECT COALESCE(severity, 'low') as severity, COUNT(*) as cnt
    FROM ghas_dependabot_alerts
    WHERE scope = ? AND scope_id = ?
      AND date(created_at) <= ?
      AND (fixed_at IS NULL OR date(fixed_at) > ?)
      AND (dismissed_at IS NULL OR date(dismissed_at) > ?)
      AND (auto_dismissed_at IS NULL OR date(auto_dismissed_at) > ?)
    GROUP BY COALESCE(severity, 'low')
  `);

  // Per-day ecosystem snapshot: open alerts on that day
  const ecosystemByDayStmt = db.prepare(`
    SELECT COALESCE(ecosystem, 'unknown') as ecosystem, COUNT(*) as cnt
    FROM ghas_dependabot_alerts
    WHERE scope = ? AND scope_id = ?
      AND date(created_at) <= ?
      AND (fixed_at IS NULL OR date(fixed_at) > ?)
      AND (dismissed_at IS NULL OR date(dismissed_at) > ?)
      AND (auto_dismissed_at IS NULL OR date(auto_dismissed_at) > ?)
    GROUP BY COALESCE(ecosystem, 'unknown')
  `);

  const sortedDays = Array.from(allDays).sort();
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO ghas_dependabot_daily
      (day, scope, scope_id, opened, fixed, dismissed, auto_dismissed, total_open,
       severity_critical, severity_high, severity_medium, severity_low, ecosystem_counts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let runningOpen = 0;
  const tx = db.transaction(() => {
    for (const day of sortedDays) {
      const opened = openedMap.get(day) || 0;
      const fixed = fixedMap.get(day) || 0;
      const dismissed = dismissedMap.get(day) || 0;
      const autoDismissed = autoDismissedMap.get(day) || 0;
      runningOpen += opened - fixed - dismissed - autoDismissed;

      // Severity snapshot for this day
      const sevRows = severityByDayStmt.all(scope, scopeId, day, day, day, day) as { severity: string; cnt: number }[];
      const sevMap: Record<string, number> = {};
      for (const r of sevRows) sevMap[r.severity] = r.cnt;

      // Ecosystem snapshot for this day
      const ecoRows = ecosystemByDayStmt.all(scope, scopeId, day, day, day, day) as { ecosystem: string; cnt: number }[];
      const ecoMap: Record<string, number> = {};
      for (const r of ecoRows) ecoMap[r.ecosystem] = r.cnt;

      insertStmt.run(
        day, scope, scopeId, opened, fixed, dismissed, autoDismissed, Math.max(0, runningOpen),
        sevMap["critical"] || 0, sevMap["high"] || 0, sevMap["medium"] || 0, sevMap["low"] || 0,
        JSON.stringify(ecoMap)
      );
    }
  });
  tx();
}

export function recomputeSecretScanningDaily(scope: string, scopeId: string): void {
  const db = getDb();

  db.prepare(`DELETE FROM ghas_secret_scanning_daily WHERE scope = ? AND scope_id = ?`).run(scope, scopeId);

  const openedByDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as cnt
    FROM ghas_secret_scanning_alerts WHERE scope = ? AND scope_id = ?
    GROUP BY date(created_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const resolvedByDay = db.prepare(`
    SELECT date(resolved_at) as day, COUNT(*) as cnt
    FROM ghas_secret_scanning_alerts WHERE scope = ? AND scope_id = ? AND resolved_at IS NOT NULL
    GROUP BY date(resolved_at)
  `).all(scope, scopeId) as { day: string; cnt: number }[];

  const allDays = new Set<string>();
  for (const r of openedByDay) allDays.add(r.day);
  for (const r of resolvedByDay) allDays.add(r.day);

  if (allDays.size === 0) return;

  const openedMap = new Map(openedByDay.map((r) => [r.day, r.cnt]));
  const resolvedMap = new Map(resolvedByDay.map((r) => [r.day, r.cnt]));

  // Per-day resolution breakdown: alerts resolved on or before this day
  const resolutionByDayStmt = db.prepare(`
    SELECT COALESCE(resolution, 'unknown') as resolution, COUNT(*) as cnt
    FROM ghas_secret_scanning_alerts
    WHERE scope = ? AND scope_id = ? AND state = 'resolved' AND date(resolved_at) <= ?
    GROUP BY COALESCE(resolution, 'unknown')
  `);

  const sortedDays = Array.from(allDays).sort();
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO ghas_secret_scanning_daily
      (day, scope, scope_id, opened, resolved, total_open, resolution_counts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let runningOpen = 0;
  const tx = db.transaction(() => {
    for (const day of sortedDays) {
      const opened = openedMap.get(day) || 0;
      const resolved = resolvedMap.get(day) || 0;
      runningOpen += opened - resolved;

      // Resolution breakdown up to this day
      const resRows = resolutionByDayStmt.all(scope, scopeId, day) as { resolution: string; cnt: number }[];
      const resMap: Record<string, number> = {};
      for (const r of resRows) resMap[r.resolution] = r.cnt;

      insertStmt.run(
        day, scope, scopeId, opened, resolved, Math.max(0, runningOpen),
        JSON.stringify(resMap)
      );
    }
  });
  tx();
}

// ── Query Operations ──────────────────────────────────────────────────

export function getCodeScanningDaily(
  scope: string, scopeId: string, startDay: string, endDay: string
): CodeScanningDaily[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM ghas_code_scanning_daily
    WHERE scope = ? AND scope_id = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(scope, scopeId, startDay, endDay) as CodeScanningDaily[];
}

export function getDependabotDaily(
  scope: string, scopeId: string, startDay: string, endDay: string
): DependabotDaily[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM ghas_dependabot_daily
    WHERE scope = ? AND scope_id = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(scope, scopeId, startDay, endDay) as Record<string, unknown>[];

  return rows.map((row) => ({
    day: row.day as string,
    scope: row.scope as string,
    scope_id: row.scope_id as string,
    opened: row.opened as number,
    fixed: row.fixed as number,
    dismissed: row.dismissed as number,
    auto_dismissed: row.auto_dismissed as number,
    total_open: row.total_open as number,
    severity_critical: row.severity_critical as number,
    severity_high: row.severity_high as number,
    severity_medium: row.severity_medium as number,
    severity_low: row.severity_low as number,
    ecosystem_counts: JSON.parse((row.ecosystem_counts as string) || "{}"),
  }));
}

export function getSecretScanningDaily(
  scope: string, scopeId: string, startDay: string, endDay: string
): SecretScanningDaily[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM ghas_secret_scanning_daily
    WHERE scope = ? AND scope_id = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(scope, scopeId, startDay, endDay) as Record<string, unknown>[];

  return rows.map((row) => ({
    day: row.day as string,
    scope: row.scope as string,
    scope_id: row.scope_id as string,
    opened: row.opened as number,
    resolved: row.resolved as number,
    total_open: row.total_open as number,
    resolution_counts: JSON.parse((row.resolution_counts as string) || "{}"),
  }));
}

// ── Security Overview ─────────────────────────────────────────────────

export function getSecurityOverview(scope: string, scopeId: string): SecurityOverview {
  const db = getDb();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const since30d = thirtyDaysAgo.toISOString();

  // Code scanning overview
  const csTotal = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'open'`
  ).get(scope, scopeId) as { cnt: number };
  const csCritical = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'open' AND severity = 'critical'`
  ).get(scope, scopeId) as { cnt: number };
  const csHigh = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'open' AND severity = 'high'`
  ).get(scope, scopeId) as { cnt: number };
  const csFixed30 = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'fixed' AND fixed_at >= ?`
  ).get(scope, scopeId, since30d) as { cnt: number };
  const csOpened30 = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND created_at >= ?`
  ).get(scope, scopeId, since30d) as { cnt: number };
  const csAutofix = db.prepare(
    `SELECT SUM(CASE WHEN autofix_status IN ('available','committed') THEN 1 ELSE 0 END) as avail, SUM(CASE WHEN autofix_status = 'committed' THEN 1 ELSE 0 END) as committed FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ?`
  ).get(scope, scopeId) as { avail: number | null; committed: number | null };

  const hasCs = csTotal.cnt > 0 || csFixed30.cnt > 0 || csOpened30.cnt > 0;
  const csTotalFixed = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'fixed'`
  ).get(scope, scopeId) as { cnt: number };
  const csTotalAll = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_code_scanning_alerts WHERE scope = ? AND scope_id = ?`
  ).get(scope, scopeId) as { cnt: number };
  const csFixRate = csTotalAll.cnt > 0 ? Math.round((csTotalFixed.cnt / csTotalAll.cnt) * 100) / 100 : 0;

  // Dependabot overview
  const depTotal = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND state = 'open'`
  ).get(scope, scopeId) as { cnt: number };
  const depCritical = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND state = 'open' AND severity = 'critical'`
  ).get(scope, scopeId) as { cnt: number };
  const depHigh = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND state = 'open' AND severity = 'high'`
  ).get(scope, scopeId) as { cnt: number };
  const depFixed30 = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND state = 'fixed' AND fixed_at >= ?`
  ).get(scope, scopeId, since30d) as { cnt: number };
  const depOpened30 = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND created_at >= ?`
  ).get(scope, scopeId, since30d) as { cnt: number };
  const depTotalFixed = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND state = 'fixed'`
  ).get(scope, scopeId) as { cnt: number };
  const depTotalAll = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ?`
  ).get(scope, scopeId) as { cnt: number };
  const depFixRate = depTotalAll.cnt > 0 ? Math.round((depTotalFixed.cnt / depTotalAll.cnt) * 100) / 100 : 0;

  const topEcosystems = db.prepare(`
    SELECT ecosystem, COUNT(*) as count
    FROM ghas_dependabot_alerts WHERE scope = ? AND scope_id = ? AND state = 'open'
    GROUP BY ecosystem ORDER BY count DESC LIMIT 5
  `).all(scope, scopeId) as { ecosystem: string; count: number }[];

  const hasDep = depTotal.cnt > 0 || depFixed30.cnt > 0 || depOpened30.cnt > 0;

  // Secret scanning overview
  const ssTotal = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_secret_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'open'`
  ).get(scope, scopeId) as { cnt: number };
  const ssResolved30 = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_secret_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'resolved' AND resolved_at >= ?`
  ).get(scope, scopeId, since30d) as { cnt: number };
  const ssOpened30 = db.prepare(
    `SELECT COUNT(*) as cnt FROM ghas_secret_scanning_alerts WHERE scope = ? AND scope_id = ? AND created_at >= ?`
  ).get(scope, scopeId, since30d) as { cnt: number };

  const resolutionBreakdown = db.prepare(`
    SELECT COALESCE(resolution, 'unknown') as resolution, COUNT(*) as cnt
    FROM ghas_secret_scanning_alerts WHERE scope = ? AND scope_id = ? AND state = 'resolved'
    GROUP BY COALESCE(resolution, 'unknown')
  `).all(scope, scopeId) as { resolution: string; cnt: number }[];

  const resBreakdownMap: Record<string, number> = {};
  for (const r of resolutionBreakdown) resBreakdownMap[r.resolution] = r.cnt;

  const hasSs = ssTotal.cnt > 0 || ssResolved30.cnt > 0 || ssOpened30.cnt > 0;

  // Compute MTTR for each
  const csMttr = computeMTTR(scope, scopeId, "code_scanning");
  const depMttr = computeMTTR(scope, scopeId, "dependabot");
  const ssMttr = computeMTTR(scope, scopeId, "secret_scanning");

  return {
    codeScanning: hasCs
      ? {
          totalOpen: csTotal.cnt,
          criticalOpen: csCritical.cnt,
          highOpen: csHigh.cnt,
          fixedLast30d: csFixed30.cnt,
          openedLast30d: csOpened30.cnt,
          autofixAvailable: csAutofix?.avail || 0,
          autofixCommitted: csAutofix?.committed || 0,
          mttrDays: csMttr,
          fixRate: csFixRate,
        }
      : null,
    dependabot: hasDep
      ? {
          totalOpen: depTotal.cnt,
          criticalOpen: depCritical.cnt,
          highOpen: depHigh.cnt,
          fixedLast30d: depFixed30.cnt,
          openedLast30d: depOpened30.cnt,
          mttrDays: depMttr,
          fixRate: depFixRate,
          topEcosystems,
        }
      : null,
    secretScanning: hasSs
      ? {
          totalOpen: ssTotal.cnt,
          resolvedLast30d: ssResolved30.cnt,
          openedLast30d: ssOpened30.cnt,
          mttrDays: ssMttr,
          resolutionBreakdown: resBreakdownMap,
        }
      : null,
  };
}

// ── Sync State Operations ─────────────────────────────────────────────

export function getGhasSyncState(
  scope: string, scopeId: string, metricType: string
): GhasSyncState | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM ghas_sync_state WHERE scope = ? AND scope_id = ? AND metric_type = ?`
  ).get(scope, scopeId, metricType);
  return row ? (row as GhasSyncState) : null;
}

export function updateGhasSyncState(
  scope: string,
  scopeId: string,
  metricType: string,
  lastSyncedAt: string,
  lastAlertUpdatedAt: string | null,
  totalAlerts: number,
  status: string,
  errorMessage: string | null = null
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO ghas_sync_state
      (scope, scope_id, metric_type, last_synced_at, last_alert_updated_at, total_alerts, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(scope, scopeId, metricType, lastSyncedAt, lastAlertUpdatedAt, totalAlerts, status, errorMessage);
}

export function getAllGhasSyncStates(): GhasSyncState[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM ghas_sync_state ORDER BY scope, scope_id, metric_type`
  ).all() as GhasSyncState[];
}

// ── MTTR Computation ──────────────────────────────────────────────────

export function computeMTTR(
  scope: string,
  scopeId: string,
  metricType: "code_scanning" | "dependabot" | "secret_scanning"
): number | null {
  const db = getDb();
  let query: string;

  if (metricType === "code_scanning") {
    query = `SELECT AVG(julianday(fixed_at) - julianday(created_at)) as avg_days
             FROM ghas_code_scanning_alerts
             WHERE scope = ? AND scope_id = ? AND state = 'fixed' AND fixed_at IS NOT NULL`;
  } else if (metricType === "dependabot") {
    query = `SELECT AVG(julianday(fixed_at) - julianday(created_at)) as avg_days
             FROM ghas_dependabot_alerts
             WHERE scope = ? AND scope_id = ? AND state = 'fixed' AND fixed_at IS NOT NULL`;
  } else {
    query = `SELECT AVG(julianday(resolved_at) - julianday(created_at)) as avg_days
             FROM ghas_secret_scanning_alerts
             WHERE scope = ? AND scope_id = ? AND state = 'resolved' AND resolved_at IS NOT NULL`;
  }

  const row = db.prepare(query).get(scope, scopeId) as { avg_days: number | null };
  return row?.avg_days ? Math.round(row.avg_days * 10) / 10 : null;
}
