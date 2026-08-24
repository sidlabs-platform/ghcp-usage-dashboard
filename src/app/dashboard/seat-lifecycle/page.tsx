"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Download, Info, UserPlus, UserMinus, ArrowUpDown, Percent } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SeatLifecycleTrendChart } from "@/components/charts/SeatLifecycleTrendChart";
import { useScope } from "@/contexts/ScopeContext";
import { useDateRangeParams } from "@/hooks/useDateRangeParams";

type EventType = "onboarded" | "offboarded";

interface LifecycleRow {
  enterprise_slug: string;
  org_slug: string;
  user_login: string;
  display_login: string;
  login_resolved: boolean;
  user_id: number | null;
  event_type: EventType;
  event_date: string;
  occurred_at: string;
  plan_type: string | null;
  assigning_team_slug: string | null;
  assigning_team_name: string | null;
  last_activity_at: string | null;
  source: "seat_created_at" | "sync_diff" | "audit_log";
}

interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

interface LifecycleAuditCoverage {
  status: "ok" | "unavailable" | "error" | "never_run";
  reason: string | null;
  coveredFrom: string | null;
  coveredThrough: string | null;
  lastSyncedAt: string | null;
  truncated: boolean;
}

interface LifecycleCoverage {
  source: "audit_log" | "sync_diff" | "none";
  trackingStartedAt: string | null;
  onboardingOnly: boolean;
  /** Absent on responses cached before the audit-log source shipped. */
  sourceBreakdown?: Partial<Record<LifecycleRow["source"], number>>;
  /** Absent on responses cached before the audit-log source shipped. */
  audit?: LifecycleAuditCoverage;
}

interface LifecycleResponse {
  window: { start: string; end: string; explicit: boolean };
  stats: {
    onboardedUsers: number;
    offboardedUsers: number;
    onboardedEvents: number;
    offboardedEvents: number;
    netChange: number;
    churnRate: number | null;
  };
  trend: { day: string; onboarded: number; offboarded: number; net: number }[];
  onboarded: { rows: LifecycleRow[]; pagination: Pagination };
  offboarded: { rows: LifecycleRow[]; pagination: Pagination };
  coverage: LifecycleCoverage;
  filtered: boolean;
  available: boolean;
}

interface SourceCoverageNoticeProps {
  coverage: LifecycleCoverage;
}

const PAGE_SIZE = 25;

const SOURCE_LABELS: Record<LifecycleRow["source"], string> = {
  seat_created_at: "Seat record",
  sync_diff: "Seat sync",
  audit_log: "Audit log",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

function isPaginationTruncationReason(reason: string): boolean {
  return reason.startsWith("Copilot audit log pagination truncated");
}

/**
 * State the provenance of the offboarding numbers, and the window they actually
 * cover, rather than letting a reader assume completeness.
 *
 * Offboarding has two possible sources with materially different accuracy, so
 * "which one is this?" is not a footnote: the audit log carries GitHub's exact
 * removal instant, while the seat-sync diff can only place a removal somewhere
 * between two syncs and knows nothing from before tracking began.
 */
function SourceCoverageNotice({ coverage }: SourceCoverageNoticeProps) {
  // A response cached before this feature shipped carries neither field. Fall
  // back to "the audit sync has not run", which is exactly what it means.
  const audit = coverage.audit ?? {
    status: "never_run" as const,
    reason: null,
    coveredFrom: null,
    coveredThrough: null,
    lastSyncedAt: null,
    truncated: false,
  };
  const sourceBreakdown = coverage.sourceBreakdown ?? {};
  const trackingStartedAt = coverage.trackingStartedAt;
  // Without a breakdown, fall back to the top-level source verdict rather than
  // silently claiming a source contributed no rows.
  const hasAuditRows = coverage.sourceBreakdown
    ? (sourceBreakdown.audit_log ?? 0) > 0
    : coverage.source === "audit_log";
  const hasDiffRows = coverage.sourceBreakdown
    ? (sourceBreakdown.sync_diff ?? 0) > 0
    : coverage.source === "sync_diff";
  const showsTruncationNotice = audit.status === "ok" && audit.truncated;
  // `reason` is a one-slot warning channel. Pagination truncation already has a
  // dedicated, clearer line below, so suppress only that known duplicate while
  // still surfacing partial-scope and skipped-event warnings on successful runs.
  const auditReason = audit.reason && !(showsTruncationNotice && isPaginationTruncationReason(audit.reason))
    ? audit.reason
    : null;
  // A successful-but-incomplete run is still a run: it must explain itself even when it
  // persisted no rows, otherwise the "tracking has not started" card below would claim
  // nothing happened while the sync actually ran and hit a limit.
  const auditIncomplete = audit.status === "ok" && (auditReason !== null || showsTruncationNotice);

  if (
    coverage.source === "none" &&
    audit.status !== "unavailable" &&
    audit.status !== "error" &&
    !auditIncomplete
  ) {
    return (
      <Card className="mb-6 p-6">
        <div className="flex items-start gap-4">
          <Info className="h-6 w-6 shrink-0 text-[hsl(var(--muted-foreground))]" />
          <div>
            <h2 className="font-semibold">Offboarding tracking has not started yet</h2>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
              Seat removals are read from the GitHub audit log on every sync, and — where the audit log is not
              available — detected by comparing each seat sync against the previous one. Run a sync to populate this
              view. Onboarding dates are read from existing seat records and are available immediately.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const lines: React.ReactNode[] = [];

  if (hasAuditRows) {
    lines.push(
      <span key="audit">
        Events are <strong className="text-[hsl(var(--foreground))]">sourced from the GitHub audit log</strong>,
        with exact assignment and removal timestamps
        {audit.coveredFrom && audit.coveredThrough && (
          <>
            , covering{" "}
            <strong className="text-[hsl(var(--foreground))]">{formatDate(audit.coveredFrom)}</strong> →{" "}
            <strong className="text-[hsl(var(--foreground))]">{formatDate(audit.coveredThrough)}</strong>
          </>
        )}
        {audit.lastSyncedAt && <> (last synced {formatDate(audit.lastSyncedAt)})</>}.
        {audit.status === "ok" && auditReason && <> {auditReason}</>}
      </span>,
    );
    if (showsTruncationNotice) {
      lines.push(
        <span key="truncated">
          The audit log returned more pages than a single sync reads, so the oldest part of this window may still be
          incomplete. Subsequent syncs continue filling it in.
        </span>,
      );
    }
  }

  if (!hasAuditRows && auditIncomplete) {
    lines.push(
      <span key="audit-incomplete">
        The audit log sync ran for this window but did not produce usable audit-log events, so{" "}
        {hasDiffRows
          ? "the offboarding shown here is derived from seat-sync snapshots"
          : "no offboarding events are shown for this window"}
        .{auditReason && <> {auditReason}</>}
      </span>,
    );
    if (showsTruncationNotice) {
      lines.push(
        <span key="truncated">
          The audit log returned more pages than a single sync reads, so the oldest part of this window may still be
          incomplete. Subsequent syncs continue filling it in.
        </span>,
      );
    }
  }

  if (audit.status === "unavailable") {
    lines.push(
      <span key="unavailable">
        <strong className="text-[hsl(var(--foreground))]">The audit log is not available</strong> for this scope, so
        exact removal timestamps cannot be read. {auditReason}
      </span>,
    );
  }

  if (audit.status === "error") {
    lines.push(
      <span key="error">
        The last audit log sync did not complete, so recent removals may be missing. {auditReason}
      </span>,
    );
  }

  // A clean, fully successful audit run that simply found zero events (no
  // reason/warning, no rows) previously fell through every branch above and
  // left the whole notice empty — silently implying "nothing to report" when
  // what's actually true is "tracked since X, nothing removed yet". Whenever
  // the audit log isn't the one supplying rows, the seat-sync coverage line
  // must still say so, regardless of whether the diff has produced any rows.
  if (trackingStartedAt && (hasDiffRows || !hasAuditRows)) {
    lines.push(
      <span key="diff">
        {hasAuditRows ? "Outside that window, offboarding" : "Offboarding"} is derived from seat-sync snapshots and
        has been tracked since{" "}
        <strong className="text-[hsl(var(--foreground))]">{formatDate(trackingStartedAt)}</strong>. Seats removed
        before that date are not recorded.
      </span>,
    );
  }

  if (lines.length === 0) return null;

  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 px-4 py-3 text-sm text-[hsl(var(--muted-foreground))]">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </div>
  );
}

function LifecycleTable({
  title,
  rows,
  pagination,
  onPageChange,
  emptyMessage,
}: {
  title: string;
  rows: LifecycleRow[];
  pagination: Pagination | undefined;
  onPageChange: (page: number) => void;
  emptyMessage: string;
}) {
  const page = pagination?.page ?? 1;
  const totalPages = pagination?.totalPages ?? 1;
  const totalItems = pagination?.totalItems ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{title}</CardTitle>
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            {totalItems.toLocaleString()} {totalItems === 1 ? "event" : "events"}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-center text-sm text-[hsl(var(--muted-foreground))]">
            {emptyMessage}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                  <th scope="col" className="pb-3 font-medium">Date</th>
                  <th scope="col" className="pb-3 font-medium">User</th>
                  <th scope="col" className="pb-3 font-medium">Org</th>
                  <th scope="col" className="pb-3 font-medium">Team</th>
                  <th scope="col" className="pb-3 font-medium">Plan</th>
                  <th scope="col" className="pb-3 font-medium">Last Activity</th>
                  <th scope="col" className="pb-3 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.enterprise_slug}-${row.org_slug}-${row.user_login}-${row.event_date}-${row.source}`}
                    className="border-b last:border-0"
                  >
                    <td className="py-3 pr-4 whitespace-nowrap">{row.event_date}</td>
                    <td className="py-3 pr-4">
                      <Link
                        href={`/dashboard/users/${encodeURIComponent(row.display_login)}`}
                        className="font-medium text-[hsl(var(--primary))] hover:underline"
                      >
                        {row.display_login}
                      </Link>
                      {row.login_resolved && (
                        <div className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                          Stored: {row.user_login}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pr-4">{row.org_slug || "—"}</td>
                    <td className="py-3 pr-4">{row.assigning_team_name ?? row.assigning_team_slug ?? "—"}</td>
                    <td className="py-3 pr-4">{row.plan_type ?? "—"}</td>
                    <td className="py-3 pr-4">{formatDate(row.last_activity_at)}</td>
                    <td className="py-3 pr-4">
                      <Badge variant="secondary">{SOURCE_LABELS[row.source]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-end gap-2 border-t pt-4 text-sm text-[hsl(var(--muted-foreground))]">
            <button
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="rounded border px-2 py-1 hover:bg-[hsl(var(--muted))] disabled:opacity-30"
            >
              Previous
            </button>
            <span aria-live="polite">Page {page} of {totalPages}</span>
            <button
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="rounded border px-2 py-1 hover:bg-[hsl(var(--muted))] disabled:opacity-30"
            >
              Next
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SeatLifecyclePage() {
  const { buildScopeParams } = useScope();
  const { buildParams, dateLabel } = useDateRangeParams();
  const [onboardedPage, setOnboardedPage] = useState(1);
  const [offboardedPage, setOffboardedPage] = useState(1);

  const scopeParams = buildScopeParams();
  const scopeKey = scopeParams.toString();
  const windowKey = buildParams().toString();
  // Pagination is meaningless once the scope or the window moves — the page-3
  // the reader was on describes a result set that no longer exists. Reset
  // during render so React discards the stale-page query before it can fetch.
  const [lastQueryKey, setLastQueryKey] = useState(`${scopeKey}|${windowKey}`);

  if (lastQueryKey !== `${scopeKey}|${windowKey}`) {
    setLastQueryKey(`${scopeKey}|${windowKey}`);
    setOnboardedPage(1);
    setOffboardedPage(1);
  }

  const queryString = useMemo(() => {
    const params = buildParams(scopeParams);
    params.set("pageSize", String(PAGE_SIZE));
    params.set("onboardedPage", String(onboardedPage));
    params.set("offboardedPage", String(offboardedPage));
    return params.toString();
    // `scopeParams` is a fresh object each render; its serialised form is the
    // real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildParams, scopeKey, onboardedPage, offboardedPage]);

  const { data, isLoading, error } = useQuery<LifecycleResponse>({
    queryKey: ["seat-lifecycle", queryString],
    queryFn: async () => {
      const res = await fetch(`/api/seats/lifecycle?${queryString}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
  });

  const stats = data?.stats;
  const coverage = data?.coverage;
  const churnRate = stats?.churnRate;

  // The export must cover the whole window, so it deliberately drops the
  // pagination params the table query carries.
  const exportParams = new URLSearchParams(queryString);
  exportParams.delete("pageSize");
  exportParams.delete("onboardedPage");
  exportParams.delete("offboardedPage");
  const exportUrl = `/api/export/seat-lifecycle?${exportParams.toString()}`;

  return (
    <div>
      <PageHeader
        title="Onboarding & Offboarding"
        description="Licensed users who gained or lost a Copilot seat in the selected window"
      >
        <a
          href={exportUrl}
          className="inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--accent))]"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </a>
      </PageHeader>
      <ScopeFilter />

      <p className="mb-6 text-xs text-[hsl(var(--muted-foreground))]">
        {dateLabel}
        {data?.window && (
          <>
            <span aria-hidden="true" className="mx-2 opacity-40">
              ·
            </span>
            {data.window.start} → {data.window.end}
          </>
        )}
      </p>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          {error instanceof Error ? error.message : "Failed to load seat lifecycle data"}
        </div>
      )}

      {/* Honest statement of what offboard data actually exists, and from where */}
      {coverage && <SourceCoverageNotice coverage={coverage} />}

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Onboarded"
          value={stats?.onboardedUsers ?? 0}
          icon={<UserPlus className="h-4 w-4" />}
          subtitle="Users who gained a seat"
        />
        <MetricCard
          title="Offboarded"
          value={stats?.offboardedUsers ?? 0}
          icon={<UserMinus className="h-4 w-4" />}
          subtitle="Users who lost a seat"
        />
        <MetricCard
          title="Net Change"
          value={stats?.netChange ?? 0}
          icon={<ArrowUpDown className="h-4 w-4" />}
          subtitle="Onboarded − offboarded"
        />
        <MetricCard
          title="Churn Rate"
          value={churnRate == null ? "—" : churnRate}
          format="percent"
          icon={<Percent className="h-4 w-4" />}
          subtitle={churnRate == null ? "No seats to compare" : "Offboarded / total seats"}
        />
      </div>

      <div className="mb-8">
        <SeatLifecycleTrendChart
          data={data?.trend ?? []}
          emptyMessage={
            isLoading ? "Loading…" : "No seat changes recorded in this window."
          }
        />
      </div>

      <div className="space-y-8">
        <LifecycleTable
          title="Onboarded Users"
          rows={data?.onboarded.rows ?? []}
          pagination={data?.onboarded.pagination}
          onPageChange={setOnboardedPage}
          emptyMessage={isLoading ? "Loading…" : "No users were onboarded in this window."}
        />
        <LifecycleTable
          title="Offboarded Users"
          rows={data?.offboarded.rows ?? []}
          pagination={data?.offboarded.pagination}
          onPageChange={setOffboardedPage}
          emptyMessage={
            isLoading
              ? "Loading…"
              : coverage?.source === "none"
                ? "Offboarding tracking has not started yet."
                : "No users were offboarded in this window."
          }
        />
      </div>

      <section className="mt-8 border-t pt-6">
        <h2 className="mb-3 text-sm font-medium text-[hsl(var(--muted-foreground))]">Related Analytics</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/seats" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Seat Management →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/users" className="text-sm text-[hsl(var(--primary))] hover:underline">
            User Explorer →
          </Link>
        </div>
      </section>
    </div>
  );
}
