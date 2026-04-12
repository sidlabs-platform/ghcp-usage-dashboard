"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreditCard, UserCheck, UserX, Percent } from "lucide-react";
import { useScope } from "@/contexts/ScopeContext";
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
}

function daysAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${diff}d ago`;
}

const thirtyDaysAgo = new Date();
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
const cutoff = thirtyDaysAgo.toISOString();

const seatColumns: ColumnDef<SeatRow>[] = [
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
      const isActive = row.last_activity_at && row.last_activity_at >= cutoff;
      const isPending = !!row.pending_cancellation_date;
      return isPending ? (
        <Badge variant="warning">Pending Cancel</Badge>
      ) : isActive ? (
        <Badge variant="success">Active</Badge>
      ) : (
        <Badge variant="secondary">Inactive</Badge>
      );
    },
  },
];

const seatExportColumns: CSVColumn[] = [
  { key: "user_login", label: "User" },
  { key: "org_slug", label: "Organization" },
  { key: "plan_type", label: "Plan" },
  { key: "last_activity_at", label: "Last Activity", format: (row) => row.last_activity_at ?? "Never" },
  { key: "last_activity_editor", label: "Editor", format: (row) => row.last_activity_editor ?? "" },
  {
    key: "status", label: "Status", format: (row) => {
      if (row.pending_cancellation_date) return "Pending Cancel";
      if (row.last_activity_at && row.last_activity_at >= cutoff) return "Active";
      return "Inactive";
    },
  },
];

export default function SeatsPage() {
  const { buildScopeParams } = useScope();
  const [showInactiveOnly, setShowInactiveOnly] = useState(false);

  const scopeParams = buildScopeParams();

  // Lightweight summary query for KPI cards
  const { data: statsData } = useQuery({
    queryKey: ["seats-stats", scopeParams.toString()],
    queryFn: async () => {
      const url = scopeParams.toString() ? `/api/seats?pageSize=1&${scopeParams}` : "/api/seats?pageSize=1";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const stats: SeatStats | undefined = statsData?.stats;
  const utilization: number | undefined = statsData?.utilization;

  const extraParams = new URLSearchParams(scopeParams.toString());
  if (showInactiveOnly) extraParams.set("inactiveOnly", "true");

  return (
    <div>
      <PageHeader title="Seat Management" description="Copilot license allocation and utilization">
        <ExportMenu
          csv={{
            fetchUrl: "/api/seats",
            extraParams,
            columns: seatExportColumns,
            dataExtractor: (json) => json.seats ?? [],
            filename: `seats-export${showInactiveOnly ? "-inactive" : ""}`,
            metadata: {
              reportName: "Seat Management",
              orgs: scopeParams.get("orgs") || undefined,
            },
          }}
        />
      </PageHeader>
      <ScopeFilter />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="Total Seats"
          value={stats?.total ?? 0}
          icon={<CreditCard className="h-4 w-4" />}
          subtitle="Assigned licenses"
        />
        <MetricCard
          title="Active (30d)"
          value={stats?.active30d ?? 0}
          icon={<UserCheck className="h-4 w-4" />}
          subtitle="Used in last 30 days"
        />
        <MetricCard
          title="Inactive (30d)"
          value={stats?.inactive30d ?? 0}
          icon={<UserX className="h-4 w-4" />}
          subtitle={`${stats?.pendingCancellation ?? 0} pending cancellation`}
        />
        <MetricCard
          title="Utilization"
          value={utilization ?? 0}
          format="percent"
          icon={<Percent className="h-4 w-4" />}
          subtitle="Active / total seats"
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
    </div>
  );
}
