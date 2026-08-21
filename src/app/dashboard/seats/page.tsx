"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { CreditCard, UserCheck, UserX, Percent } from "lucide-react";
import { useScope } from "@/contexts/ScopeContext";
import { useDateRangeParams } from "@/hooks/useDateRangeParams";
import { useQuery } from "@tanstack/react-query";
import { PaginatedTable, type ColumnDef } from "@/components/tables/PaginatedTable";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { CSVColumn } from "@/lib/export/csv";

interface SeatRow {
  org_slug: string;
  user_login: string;
  user_id: number;
  plan_type: string;
  last_activity_at: string | null;
  last_activity_editor: string | null;
  assigning_team_slug: string | null;
  assigning_team_name: string | null;
  pending_cancellation_date: string | null;
  created_at: string;
  avatar_url: string | null;
}

interface SeatStats {
  total: number;
  active30d: number;
  inactive30d: number;
  pendingCancellation: number;
  /** ISO timestamp the API used as the activity cutoff for this window. */
  activitySince?: string;
  /** Inclusive upper bound for historical windows; null/absent means current live activity is included. */
  activityUntil?: string | null;
}

function daysAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${diff}d ago`;
}

function fallbackCutoff(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

function seatStatus(row: SeatRow, cutoff: string, until: string | null): "Pending Cancel" | "Active" | "Inactive" {
  if (row.pending_cancellation_date) return "Pending Cancel";
  return row.last_activity_at && row.last_activity_at >= cutoff && (until === null || row.last_activity_at <= until)
    ? "Active"
    : "Inactive";
}

/**
 * Seat table columns. The active/inactive cutoff is a parameter rather than a
 * module constant because the status badge must agree with the KPI tiles above
 * it, and those follow the selected window.
 */
function buildSeatColumns(cutoff: string, until: string | null): ColumnDef<SeatRow>[] {
  return [
    { key: "user_login", label: "User", render: (row) => <span className="font-medium">{row.user_login}</span> },
    { key: "org_slug", label: "Org", render: (row) => row.org_slug },
    { key: "plan_type", label: "Plan", render: (row) => row.plan_type },
    { key: "last_activity_at", label: "Last Activity", render: (row) => daysAgo(row.last_activity_at) },
    { key: "last_activity_editor", label: "Editor", render: (row) => row.last_activity_editor ?? "—" },
    {
      key: "status",
      label: "Status",
      sortable: false,
      render: (row) => {
        const status = seatStatus(row, cutoff, until);
        if (status === "Pending Cancel") return <Badge variant="warning">Pending Cancel</Badge>;
        if (status === "Active") return <Badge variant="success">Active</Badge>;
        return <Badge variant="secondary">Inactive</Badge>;
      },
    },
  ];
}

function buildSeatExportColumns(cutoff: string, until: string | null): CSVColumn[] {
  return [
    { key: "user_login", label: "User" },
    { key: "org_slug", label: "Organization" },
    { key: "plan_type", label: "Plan" },
    { key: "last_activity_at", label: "Last Activity", format: (row) => row.last_activity_at ?? "Never" },
    { key: "last_activity_editor", label: "Editor", format: (row) => row.last_activity_editor ?? "" },
    { key: "status", label: "Status", format: (row) => seatStatus(row as unknown as SeatRow, cutoff, until) },
  ];
}

export default function SeatsPage() {
  const { buildScopeParams } = useScope();
  const { buildParams, dateLabel, filenameSuffix } = useDateRangeParams();
  const [showInactiveOnly, setShowInactiveOnly] = useState(false);

  const scopeParams = buildScopeParams();
  const windowParams = buildParams(scopeParams);
  const windowKey = windowParams.toString();

  // Lightweight summary query for KPI cards
  const { data: statsData } = useQuery({
    queryKey: ["seats-stats", windowKey],
    queryFn: async () => {
      const res = await fetch(`/api/seats?pageSize=1&${windowKey}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const stats: SeatStats | undefined = statsData?.stats;
  const utilization: number | undefined = statsData?.utilization;
  const defaultCutoff = useMemo(() => fallbackCutoff(), []);
  const cutoff = stats?.activitySince ?? defaultCutoff;
  // Absent on responses cached before this field existed, which correctly means
  // "no upper bound", so today's live activity still counts.
  const until = stats?.activityUntil ?? null;

  const seatColumns = useMemo(() => buildSeatColumns(cutoff, until), [cutoff, until]);
  const seatExportColumns = useMemo(() => buildSeatExportColumns(cutoff, until), [cutoff, until]);

  const extraParams = new URLSearchParams(windowKey);
  if (showInactiveOnly) extraParams.set("inactiveOnly", "true");

  return (
    <div>
      <PageHeader title="Seat Management" description="License allocation, active vs inactive seat tracking">
        <ExportMenu
          csv={{
            fetchUrl: "/api/seats",
            extraParams,
            columns: seatExportColumns,
            dataExtractor: (json) => json.seats ?? [],
            filename: `seats-export-${filenameSuffix}${showInactiveOnly ? "-inactive" : ""}`,
            metadata: {
              reportName: "Seat Management",
              dateRange: dateLabel,
              orgs: scopeParams.get("orgs") || undefined,
            },
          }}
        />
      </PageHeader>
      <ScopeFilter />

      <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
        Seat assignments are a live snapshot of today — GitHub does not report seat history, so Total
        Seats cannot be scoped to a past window. Activity split window: {dateLabel}
        {until === null ? ", including today's live activity." : "."}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="Total Seats"
          value={stats?.total ?? 0}
          icon={<CreditCard className="h-4 w-4" />}
          subtitle="Assigned licenses (current snapshot)"
        />
        <MetricCard
          title="Active in window"
          value={stats?.active30d ?? 0}
          icon={<UserCheck className="h-4 w-4" />}
          subtitle={`Used during ${dateLabel}`}
        />
        <MetricCard
          title="Inactive in window"
          value={stats?.inactive30d ?? 0}
          icon={<UserX className="h-4 w-4" />}
          subtitle={`${stats?.pendingCancellation ?? 0} pending cancellation`}
        />
        <MetricCard
          title="Utilization"
          value={utilization ?? 0}
          format="percent"
          icon={<Percent className="h-4 w-4" />}
          subtitle="Active in window / total seats"
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{showInactiveOnly ? "Inactive Seats" : "All Seats"}</CardTitle>
            <button
              onClick={() => setShowInactiveOnly(!showInactiveOnly)}
              className="text-sm px-3 py-1.5 rounded-md border hover:bg-[hsl(var(--muted))]"
            >
              {showInactiveOnly ? "Show All" : "Show Inactive Only"}
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <PaginatedTable<SeatRow>
            fetchUrl="/api/seats"
            extraParams={extraParams}
            columns={seatColumns}
            defaultSort="last_activity_at"
            rowKey={(row) => `${row.org_slug}-${row.user_login}`}
            dataExtractor={(json) => (json.seats as SeatRow[]) ?? []}
            queryKey="seats-table"
            searchable
            searchPlaceholder="Search seats…"
          />
        </CardContent>
      </Card>

      {/* Related Analytics */}
      <section className="mt-8 pt-6 border-t">
        <h2 className="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Related Analytics</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/users" className="text-sm text-[hsl(var(--primary))] hover:underline">
            User Explorer →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/teams" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Team Analytics →
          </Link>
        </div>
      </section>
    </div>
  );
}
