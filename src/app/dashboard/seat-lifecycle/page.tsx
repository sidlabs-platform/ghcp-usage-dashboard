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
  coverage: {
    source: "audit_log" | "sync_diff" | "none";
    trackingStartedAt: string | null;
    onboardingOnly: boolean;
  };
  filtered: boolean;
  available: boolean;
}

const DAY_PRESETS = [7, 14, 30, 60, 90];
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
  const [days, setDays] = useState(30);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [onboardedPage, setOnboardedPage] = useState(1);
  const [offboardedPage, setOffboardedPage] = useState(1);

  const scopeParams = buildScopeParams();
  const scopeKey = scopeParams.toString();
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey);

  if (lastScopeKey !== scopeKey) {
    // Reset during render so React discards the stale-page query before it can fetch.
    setLastScopeKey(scopeKey);
    setOnboardedPage(1);
    setOffboardedPage(1);
  }

  // Both custom dates must be set before the override is applied; a half-filled
  // pair would otherwise make the API 400 on every keystroke.
  const useCustomRange = customStart !== "" && customEnd !== "";
  const rangeInvalid = useCustomRange && customEnd < customStart;

  const queryString = useMemo(() => {
    const params = new URLSearchParams(scopeKey);
    if (useCustomRange && !rangeInvalid) {
      params.set("start", customStart);
      params.set("end", customEnd);
    } else {
      params.set("days", String(days));
    }
    params.set("pageSize", String(PAGE_SIZE));
    params.set("onboardedPage", String(onboardedPage));
    params.set("offboardedPage", String(offboardedPage));
    return params.toString();
  }, [scopeKey, useCustomRange, rangeInvalid, customStart, customEnd, days, onboardedPage, offboardedPage]);

  const { data, isLoading, error } = useQuery<LifecycleResponse>({
    queryKey: ["seat-lifecycle", queryString],
    enabled: !rangeInvalid,
    queryFn: async () => {
      const res = await fetch(`/api/seats/lifecycle?${queryString}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
  });

  const resetPages = () => {
    setOnboardedPage(1);
    setOffboardedPage(1);
  };

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

      {/* Window control: presets plus an optional explicit override */}
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <span className="mb-1.5 block text-xs font-medium text-[hsl(var(--muted-foreground))]">Time window</span>
          <div className="flex gap-1" role="group" aria-label="Preset time window">
            {DAY_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setDays(preset);
                  setCustomStart("");
                  setCustomEnd("");
                  resetPages();
                }}
                aria-pressed={!useCustomRange && days === preset}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  !useCustomRange && days === preset
                    ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]"
                    : "hover:bg-[hsl(var(--muted))]"
                }`}
              >
                {preset}d
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div>
            <label htmlFor="lifecycle-start" className="mb-1.5 block text-xs font-medium text-[hsl(var(--muted-foreground))]">
              From
            </label>
            <input
              id="lifecycle-start"
              type="date"
              value={customStart}
              onChange={(e) => {
                setCustomStart(e.target.value);
                resetPages();
              }}
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="lifecycle-end" className="mb-1.5 block text-xs font-medium text-[hsl(var(--muted-foreground))]">
              To
            </label>
            <input
              id="lifecycle-end"
              type="date"
              value={customEnd}
              onChange={(e) => {
                setCustomEnd(e.target.value);
                resetPages();
              }}
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          {useCustomRange && (
            <button
              onClick={() => {
                setCustomStart("");
                setCustomEnd("");
                resetPages();
              }}
              className="h-9 rounded-md border px-3 text-sm hover:bg-[hsl(var(--muted))]"
            >
              Clear
            </button>
          )}
        </div>

        {data?.window && (
          <p className="pb-2 text-xs text-[hsl(var(--muted-foreground))]">
            Showing {data.window.start} → {data.window.end}
          </p>
        )}
      </div>

      {rangeInvalid && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          The &ldquo;From&rdquo; date must be on or before the &ldquo;To&rdquo; date.
        </div>
      )}

      {error && !rangeInvalid && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          {error instanceof Error ? error.message : "Failed to load seat lifecycle data"}
        </div>
      )}

      {/* Honest statement of what offboard data actually exists */}
      {coverage?.source === "none" && (
        <Card className="mb-6 p-6">
          <div className="flex items-start gap-4">
            <Info className="h-6 w-6 shrink-0 text-[hsl(var(--muted-foreground))]" />
            <div>
              <h2 className="font-semibold">Offboarding tracking has not started yet</h2>
              <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                Seat removals are detected by comparing each seat sync against the previous one, so offboarding data
                begins accumulating from the next sync. Onboarding dates are read from existing seat records and are
                available immediately. If your enterprise has the licensing history sync enabled, exact historical
                onboarding and offboarding events are imported from the audit log instead.
              </p>
            </div>
          </div>
        </Card>
      )}

      {coverage?.source === "sync_diff" && coverage.trackingStartedAt && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 px-4 py-3 text-sm text-[hsl(var(--muted-foreground))]">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Offboarding is derived from seat-sync snapshots and has been tracked since{" "}
            <strong className="text-[hsl(var(--foreground))]">{formatDate(coverage.trackingStartedAt)}</strong>. Seats
            removed before that date are not recorded.
          </span>
        </div>
      )}

      {coverage?.source === "audit_log" && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 px-4 py-3 text-sm text-[hsl(var(--muted-foreground))]">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Events sourced from the enterprise audit log, with exact assignment and removal dates.</span>
        </div>
      )}

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
