"use client";

// Deterministic recent-run list for the active enterprise, with drill-down
// into a single run's sanitized report (Task 10
// `/api/billing/license-reconciliation/runs` + `/runs/{id}`). Selecting a run
// reports both the raw id (`onSelectRun`) and the fetched sanitized report
// object (`onReportChange`) so the parent page can feed
// `LicenseDataQualityPanel` without this component needing to know how the
// report is rendered.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { LicenseRunReportObject } from "@/lib/db/license-run-repo";

export interface LicenseRunSummary {
  id: string;
  enterpriseSlug: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  requestedPeriods: string[];
  checkCounts: { pass: number; warning: number; fail: number };
  warningCount: number;
  hasError: boolean;
}

export interface LicenseRunHistoryProps {
  enterpriseSlug: string | null;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onReportChange: (report: LicenseRunReportObject | null) => void;
}

function formatElapsed(elapsedMs: number | null): string {
  if (elapsedMs == null) return "—";
  const seconds = Math.round(elapsedMs / 1000);
  return `${seconds}s`;
}

export function LicenseRunHistory({ enterpriseSlug, selectedRunId, onSelectRun, onReportChange }: LicenseRunHistoryProps) {
  const [runs, setRuns] = useState<LicenseRunSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!enterpriseSlug) {
      setRuns([]);
      setListError(null);
      return;
    }
    const seq = ++requestSeq.current;
    setListLoading(true);
    setListError(null);
    fetch(`/api/billing/license-reconciliation/runs?enterprise=${encodeURIComponent(enterpriseSlug)}&limit=20`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (requestSeq.current !== seq) return;
        if (!res.ok) {
          setListError("Failed to load run history.");
          setRuns([]);
          return;
        }
        const payload = (await res.json()) as { runs: LicenseRunSummary[] };
        if (requestSeq.current !== seq) return;
        setRuns(payload.runs ?? []);
      })
      .catch(() => {
        if (requestSeq.current !== seq) return;
        setListError("Failed to load run history.");
        setRuns([]);
      })
      .finally(() => {
        if (requestSeq.current !== seq) return;
        setListLoading(false);
      });
  }, [enterpriseSlug, retryToken]);

  const handleSelect = (runId: string) => {
    onSelectRun(runId);
    if (!enterpriseSlug) return;
    const seq = ++requestSeq.current;
    fetch(`/api/billing/license-reconciliation/runs/${encodeURIComponent(runId)}?enterprise=${encodeURIComponent(enterpriseSlug)}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (requestSeq.current !== seq) return;
        if (!res.ok) {
          onReportChange(null);
          return;
        }
        const report = (await res.json()) as LicenseRunReportObject;
        if (requestSeq.current !== seq) return;
        onReportChange(report);
      })
      .catch(() => {
        if (requestSeq.current !== seq) return;
        onReportChange(null);
      });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, runId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelect(runId);
    }
  };

  if (!enterpriseSlug) {
    return (
      <div className="rounded-lg border p-6 text-sm text-[hsl(var(--muted-foreground))]">
        Select an enterprise to view reconciliation run history.
      </div>
    );
  }

  if (listLoading && runs.length === 0) {
    return (
      <div role="status" className="rounded-lg border p-6 text-sm text-[hsl(var(--muted-foreground))]">
        Loading run history…
      </div>
    );
  }

  if (listError) {
    return (
      <div role="alert" className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        <p>{listError}</p>
        <button
          type="button"
          onClick={() => setRetryToken((t) => t + 1)}
          className="rounded-md border border-red-400 px-3 py-1 text-xs font-medium hover:bg-red-100 dark:hover:bg-red-900/40"
        >
          Retry
        </button>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border p-6 text-sm text-[hsl(var(--muted-foreground))]">
        No reconciliation runs recorded yet for this enterprise.
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-lg border text-sm">
      {runs.map((run) => {
        const isSelected = run.id === selectedRunId;
        return (
          <li key={run.id}>
            <button
              type="button"
              aria-current={isSelected ? "true" : undefined}
              onClick={() => handleSelect(run.id)}
              onKeyDown={(e) => handleKeyDown(e, run.id)}
              className={`flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] ${
                isSelected ? "bg-[hsl(var(--accent))]" : "hover:bg-[hsl(var(--accent))]/50"
              }`}
            >
              <span className="font-medium">{run.id}</span>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">{run.status}</span>
              <span className="text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                {run.requestedPeriods.join(", ")}
              </span>
              <span className="text-xs tabular-nums text-[hsl(var(--muted-foreground))]">{formatElapsed(run.elapsedMs)}</span>
              <span className="text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                {run.checkCounts.pass} pass / {run.checkCounts.warning} warn / {run.checkCounts.fail} fail
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
