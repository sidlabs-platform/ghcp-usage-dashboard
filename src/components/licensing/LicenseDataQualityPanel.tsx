"use client";

// Sanitized data-quality surface for the historical reconciliation runs:
// check pass/warning/fail summaries, source coverage, history-confidence
// distribution, safe unresolved holder keys, and warnings. Every field
// rendered here must come from the Task 10 sanitized `LicenseRunReportObject`
// — raw `sourceStats`, `externalIdentity`, tokens, or any other unsanitized
// payload must never be rendered (see `license-run-repo.ts`'s
// `sanitizeReportRecord`/`sanitizeUnresolvedIdentity`).

import type { LicenseRunReportObject } from "@/lib/db/license-run-repo";

export interface DataQualityCoverage {
  mode: string;
  periods: string[];
  view: string;
}

export interface LicenseDataQualityPanelProps {
  coverage: DataQualityCoverage | null;
  warnings: string[];
  report: LicenseRunReportObject | null;
  reportLoading: boolean;
  reportError: string | null;
}

const MAX_VISIBLE_UNRESOLVED = 20;

function statusIcon(status: "pass" | "warning" | "fail"): string {
  if (status === "pass") return "✓";
  if (status === "warning") return "!";
  return "✕";
}

function statusStyles(status: "pass" | "warning" | "fail"): string {
  if (status === "pass") return "text-emerald-700 dark:text-emerald-400";
  if (status === "warning") return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

function holderKeyOf(entry: Record<string, unknown>): string {
  const value = entry["holderKey"];
  return typeof value === "string" ? value : "unknown";
}

export function LicenseDataQualityPanel({ coverage, warnings, report, reportLoading, reportError }: LicenseDataQualityPanelProps) {
  if (reportLoading) {
    return (
      <div role="status" className="rounded-lg border p-6 text-sm text-[hsl(var(--muted-foreground))]">
        Loading data quality report…
      </div>
    );
  }

  if (reportError) {
    return (
      <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        {reportError}
      </div>
    );
  }

  if (!report) {
    return (
      <div className="rounded-lg border p-6 text-sm text-[hsl(var(--muted-foreground))]">
        No reconciliation run is available for the current selection. Run a sync or select a run from history to view data
        quality diagnostics.
      </div>
    );
  }

  const { checkCounts, checks, sources, diagnostics, unresolvedIdentities, warnings: reportWarnings } = report;
  const visibleUnresolved = unresolvedIdentities.slice(0, MAX_VISIBLE_UNRESOLVED);
  const hiddenUnresolvedCount = Math.max(0, unresolvedIdentities.length - visibleUnresolved.length);
  const allWarnings = [...warnings, ...reportWarnings];

  return (
    <div className="space-y-6">
      {coverage && (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Coverage: {coverage.mode} · {coverage.periods.join(", ") || "current"} · {coverage.view} view
        </p>
      )}

      {/* Check severity counts */}
      <section aria-labelledby="dq-checks-heading" className="space-y-2">
        <h3 id="dq-checks-heading" className="text-sm font-semibold">
          Reconciliation checks
        </h3>
        <div className="flex flex-wrap gap-4 text-sm">
          <span className={statusStyles("pass")}>
            {statusIcon("pass")} {checkCounts.pass} pass
          </span>
          <span className={statusStyles("warning")}>
            {statusIcon("warning")} {checkCounts.warning} warning
          </span>
          <span className={statusStyles("fail")}>
            {statusIcon("fail")} {checkCounts.fail} fail
          </span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              <th scope="col" className="py-1">Check</th>
              <th scope="col" className="py-1">Status</th>
              <th scope="col" className="py-1">Message</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check, idx) => (
              <tr key={`${check.name}:${check.billingPeriod}:${check.orgLogin}:${idx}`} className="border-b last:border-0">
                <td className="py-1">{check.name}</td>
                <td className={`py-1 ${statusStyles(check.status as "pass" | "warning" | "fail")}`}>
                  {statusIcon(check.status as "pass" | "warning" | "fail")} {check.status}
                </td>
                <td className="py-1 text-[hsl(var(--muted-foreground))]">{check.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Source coverage */}
      <section aria-labelledby="dq-sources-heading" className="space-y-2">
        <h3 id="dq-sources-heading" className="text-sm font-semibold">
          Source coverage
        </h3>
        <ul className="space-y-1 text-sm">
          {sources.map((source) => (
            <li key={`${source.source}:${source.billingPeriod}`} className="flex flex-wrap gap-2">
              <span className="font-medium">{source.source}</span>
              <span className="text-[hsl(var(--muted-foreground))]">
                {source.billingPeriod} · {source.status} · {source.coverageStart ?? "—"} to {source.coverageEnd ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* History confidence */}
      <section aria-labelledby="dq-confidence-heading" className="space-y-2">
        <h3 id="dq-confidence-heading" className="text-sm font-semibold">
          History confidence
        </h3>
        <ul className="flex flex-wrap gap-4 text-sm tabular-nums">
          {diagnostics.historyCoverage.map((entry) => (
            <li key={entry.confidence}>
              {entry.confidence}: <span className="font-medium">{entry.count}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Request/row counts */}
      <section aria-labelledby="dq-counts-heading" className="space-y-2">
        <h3 id="dq-counts-heading" className="text-sm font-semibold">
          Request &amp; row counts
        </h3>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-[hsl(var(--muted-foreground))]">Materialized rows</dt>
            <dd className="tabular-nums font-medium">{diagnostics.materializedRowCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-[hsl(var(--muted-foreground))]">Active seat rows</dt>
            <dd className="tabular-nums font-medium">{diagnostics.activeSeatRowCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-[hsl(var(--muted-foreground))]">Consumption rows</dt>
            <dd className="tabular-nums font-medium">{diagnostics.consumptionRowCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-[hsl(var(--muted-foreground))]">API requests</dt>
            <dd className="tabular-nums font-medium">{diagnostics.apiRequestCounts.total}</dd>
          </div>
        </dl>
      </section>

      {/* Unresolved identities (safe holder keys only) */}
      <section>
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer text-sm font-semibold">
            Unresolved holders ({unresolvedIdentities.length})
          </summary>
          {unresolvedIdentities.length === 0 ? (
            <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">No unresolved identities.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm tabular-nums">
              {visibleUnresolved.map((entry, idx) => (
                <li key={`${holderKeyOf(entry)}:${idx}`}>{holderKeyOf(entry)}</li>
              ))}
              {hiddenUnresolvedCount > 0 && (
                <li className="text-xs text-[hsl(var(--muted-foreground))]">+{hiddenUnresolvedCount} more</li>
              )}
            </ul>
          )}
        </details>
      </section>

      {/* Warnings */}
      {allWarnings.length > 0 && (
        <section aria-labelledby="dq-warnings-heading" className="space-y-1">
          <h3 id="dq-warnings-heading" className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            Warnings
          </h3>
          <ul className="list-inside list-disc text-sm text-amber-800 dark:text-amber-300">
            {allWarnings.map((warning, idx) => (
              <li key={idx}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
