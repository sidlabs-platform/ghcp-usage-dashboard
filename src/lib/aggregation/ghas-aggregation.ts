// GHAS (GitHub Advanced Security) aggregation and insights
// Pure functions that compute security metrics from daily aggregate data

import type {
  CodeScanningDaily,
  DependabotDaily,
  SecretScanningDaily,
} from "@/lib/types/ghas";

// ── Fix Rate ──────────────────────────────────────────────────────────

/** Compute fix rate as a percentage across all daily records */
export function computeFixRate(
  dailyData: { opened: number; fixed: number }[]
): number {
  if (dailyData.length === 0) return 0;
  let totalOpened = 0;
  let totalFixed = 0;
  for (const d of dailyData) {
    totalOpened += d.opened;
    totalFixed += d.fixed;
  }
  return totalOpened > 0 ? (totalFixed / totalOpened) * 100 : 0;
}

// ── Autofix Adoption (Code Scanning) ──────────────────────────────────

export interface AutofixAdoption {
  rate: number;
  totalAvailable: number;
  totalCommitted: number;
}

/** Compute autofix adoption rate from the latest day's counts */
export function computeAutofixAdoption(
  dailyData: CodeScanningDaily[]
): AutofixAdoption {
  if (dailyData.length === 0) {
    return { rate: 0, totalAvailable: 0, totalCommitted: 0 };
  }
  const sorted = [...dailyData].sort((a, b) => a.day.localeCompare(b.day));
  const latest = sorted[sorted.length - 1];
  const totalAvailable = latest.autofix_available;
  const totalCommitted = latest.autofix_committed;
  const rate = totalAvailable > 0 ? (totalCommitted / totalAvailable) * 100 : 0;
  return { rate, totalAvailable, totalCommitted };
}

// ── Trend Direction (7-day moving average comparison) ─────────────────

/** Compare last-7-day average vs prior-7-day average.
 *  Returns "up" / "down" / "flat" based on a >5% change threshold. */
export function computeTrendDirection(
  values: number[]
): "up" | "down" | "flat" {
  if (values.length < 14) return "flat";
  const recent7 = values.slice(-7);
  const prev7 = values.slice(-14, -7);
  const recentAvg = recent7.reduce((s, v) => s + v, 0) / 7;
  const prevAvg = prev7.reduce((s, v) => s + v, 0) / 7;
  if (prevAvg === 0) return recentAvg > 0 ? "up" : "flat";
  const change = (recentAvg - prevAvg) / prevAvg;
  if (change > 0.05) return "up";
  if (change < -0.05) return "down";
  return "flat";
}

// ── Top Ecosystems (Dependabot) ───────────────────────────────────────

/** Return top ecosystems by alert count from the latest day's ecosystem_counts */
export function getTopEcosystems(
  dailyData: DependabotDaily[],
  limit = 5
): { ecosystem: string; count: number }[] {
  if (dailyData.length === 0) return [];
  const sorted = [...dailyData].sort((a, b) => a.day.localeCompare(b.day));
  const latest = sorted[sorted.length - 1];
  const counts = latest.ecosystem_counts ?? {};
  return Object.entries(counts)
    .map(([ecosystem, count]) => ({ ecosystem, count: count as number }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ── Severity Distribution ─────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#f59e0b",
  low: "#3b82f6",
};

/** Return severity breakdown from the latest day, ordered critical→low */
export function getSeverityDistribution(
  dailyData: {
    severity_critical: number;
    severity_high: number;
    severity_medium: number;
    severity_low: number;
  }[]
): { severity: string; count: number; color: string }[] {
  if (dailyData.length === 0) return [];
  const latest = dailyData[dailyData.length - 1];
  return [
    { severity: "critical", count: latest.severity_critical, color: SEVERITY_COLORS.critical },
    { severity: "high", count: latest.severity_high, color: SEVERITY_COLORS.high },
    { severity: "medium", count: latest.severity_medium, color: SEVERITY_COLORS.medium },
    { severity: "low", count: latest.severity_low, color: SEVERITY_COLORS.low },
  ];
}

// ── Aggregate Security Summary ────────────────────────────────────────

export interface SecuritySummary {
  totalOpenAlerts: number;
  criticalAlerts: number;
  highAlerts: number;
  fixedLast30d: number;
  openedLast30d: number;
  overallFixRate: number;
  trendDirection: "up" | "down" | "flat";
  autofixAdoptionRate: number;
  categories: {
    codeScanning: { totalOpen: number; trend: "up" | "down" | "flat" } | null;
    dependabot: { totalOpen: number; trend: "up" | "down" | "flat" } | null;
    secretScanning: { totalOpen: number; trend: "up" | "down" | "flat" } | null;
  };
}

/** Build a cross-category security summary from all three daily streams */
export function computeSecuritySummary(
  csDaily: CodeScanningDaily[],
  depDaily: DependabotDaily[],
  ssDaily: SecretScanningDaily[]
): SecuritySummary {
  // Sort each series chronologically
  const cs = [...csDaily].sort((a, b) => a.day.localeCompare(b.day));
  const dep = [...depDaily].sort((a, b) => a.day.localeCompare(b.day));
  const ss = [...ssDaily].sort((a, b) => a.day.localeCompare(b.day));

  // Latest-day totals
  const csLatest = cs.length > 0 ? cs[cs.length - 1] : null;
  const depLatest = dep.length > 0 ? dep[dep.length - 1] : null;
  const ssLatest = ss.length > 0 ? ss[ss.length - 1] : null;

  const totalOpenAlerts =
    (csLatest?.total_open ?? 0) +
    (depLatest?.total_open ?? 0) +
    (ssLatest?.total_open ?? 0);

  const criticalAlerts =
    (csLatest?.severity_critical ?? 0) +
    (depLatest?.severity_critical ?? 0);

  const highAlerts =
    (csLatest?.severity_high ?? 0) +
    (depLatest?.severity_high ?? 0);

  // Opened / fixed across all days (secret scanning uses "resolved" instead of "fixed")
  const fixedLast30d =
    cs.reduce((s, d) => s + d.fixed, 0) +
    dep.reduce((s, d) => s + d.fixed, 0) +
    ss.reduce((s, d) => s + d.resolved, 0);

  const openedLast30d =
    cs.reduce((s, d) => s + d.opened, 0) +
    dep.reduce((s, d) => s + d.opened, 0) +
    ss.reduce((s, d) => s + d.opened, 0);

  // Combined fix rate (treat secret-scanning "resolved" as "fixed")
  const combinedDaily = [
    ...cs.map((d) => ({ opened: d.opened, fixed: d.fixed })),
    ...dep.map((d) => ({ opened: d.opened, fixed: d.fixed })),
    ...ss.map((d) => ({ opened: d.opened, fixed: d.resolved })),
  ];
  const overallFixRate = computeFixRate(combinedDaily);

  // Trend on total_open (merge all three series by day)
  const openByDay = new Map<string, number>();
  for (const d of cs) openByDay.set(d.day, (openByDay.get(d.day) ?? 0) + d.total_open);
  for (const d of dep) openByDay.set(d.day, (openByDay.get(d.day) ?? 0) + d.total_open);
  for (const d of ss) openByDay.set(d.day, (openByDay.get(d.day) ?? 0) + d.total_open);
  const sortedDays = Array.from(openByDay.keys()).sort();
  const totalOpenValues = sortedDays.map((day) => openByDay.get(day)!);
  const trendDirection = computeTrendDirection(totalOpenValues);

  // Autofix adoption
  const autofixAdoptionRate = computeAutofixAdoption(cs).rate;

  // Per-category summaries
  const csCat =
    cs.length > 0
      ? {
          totalOpen: csLatest!.total_open,
          trend: computeTrendDirection(cs.map((d) => d.total_open)),
        }
      : null;

  const depCat =
    dep.length > 0
      ? {
          totalOpen: depLatest!.total_open,
          trend: computeTrendDirection(dep.map((d) => d.total_open)),
        }
      : null;

  const ssCat =
    ss.length > 0
      ? {
          totalOpen: ssLatest!.total_open,
          trend: computeTrendDirection(ss.map((d) => d.total_open)),
        }
      : null;

  return {
    totalOpenAlerts,
    criticalAlerts,
    highAlerts,
    fixedLast30d,
    openedLast30d,
    overallFixRate,
    trendDirection,
    autofixAdoptionRate,
    categories: {
      codeScanning: csCat,
      dependabot: depCat,
      secretScanning: ssCat,
    },
  };
}

// ── Format Helpers ────────────────────────────────────────────────────

/** Format mean-time-to-remediation into a human-readable string */
export function formatMTTR(days: number | null): string {
  if (days === null) return "N/A";
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${days.toFixed(1)}d`;
  return `${(days / 30).toFixed(1)}mo`;
}
