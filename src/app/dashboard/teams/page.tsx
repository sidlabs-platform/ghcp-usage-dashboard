"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { useDateRangeParams } from "@/hooks/useDateRangeParams";
import { useScope } from "@/contexts/ScopeContext";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Users } from "lucide-react";
import { PaginatedTable, type ColumnDef } from "@/components/tables/PaginatedTable";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { CSVColumn } from "@/lib/export/csv";
import { formatNumber, safeNum } from "@/lib/utils";

interface TeamSummary {
  teamSlug: string;
  teamName: string;
  source: string;
  orgSlug: string | null;
  totalMembers: number;
  avgDailyActiveUsers: number;
  totalLocAdded: number;
  totalInteractions: number;
  overallAcceptanceRate: number;
  agentAdoptionRate: number;
  chatAdoptionRate: number;
  cliAdoptionRate: number;
  codeReviewAdoptionRate: number;
}

const teamColumns: ColumnDef<TeamSummary>[] = [
  {
    key: "teamName",
    label: "Team",
    render: (row) => (
      <>
        <Link href={`/dashboard/teams/${row.teamSlug}?source=${encodeURIComponent(row.source)}`} className="font-medium text-[hsl(var(--primary))] hover:underline">
          {row.teamName}
        </Link>
        <Badge variant="outline" className="ml-2 text-[10px]">{row.source}</Badge>
      </>
    ),
  },
  { key: "totalMembers", label: "Members", align: "right", render: (row) => row.totalMembers },
  {
    key: "avgDailyActiveUsers",
    label: "Active Users",
    align: "right",
    render: (row) => {
      const adoption = row.totalMembers > 0 ? ((row.avgDailyActiveUsers / row.totalMembers) * 100) : 0;
      return (
        <>
          {safeNum(row.avgDailyActiveUsers).toFixed(1)}
          <span className="ml-1 text-xs text-[hsl(var(--muted-foreground))]">({adoption.toFixed(0)}%)</span>
        </>
      );
    },
  },
  { key: "totalLocAdded", label: "LoC Added", align: "right", render: (row) => formatNumber(row.totalLocAdded) },
  { key: "overallAcceptanceRate", label: "Acceptance %", align: "right", render: (row) => `${safeNum(row.overallAcceptanceRate).toFixed(1)}%` },
  {
    key: "agentAdoptionRate",
    label: "Agent",
    align: "right",
    render: (row) => (
      <Badge variant={row.agentAdoptionRate >= 50 ? "success" : row.agentAdoptionRate >= 20 ? "warning" : "secondary"}>
        {safeNum(row.agentAdoptionRate).toFixed(1)}%
      </Badge>
    ),
  },
  {
    key: "chatAdoptionRate",
    label: "Chat",
    align: "right",
    render: (row) => (
      <Badge variant={row.chatAdoptionRate >= 50 ? "success" : row.chatAdoptionRate >= 20 ? "warning" : "secondary"}>
        {safeNum(row.chatAdoptionRate).toFixed(1)}%
      </Badge>
    ),
  },
  {
    key: "cliAdoptionRate",
    label: "CLI",
    align: "right",
    render: (row) => (
      <Badge variant={row.cliAdoptionRate >= 50 ? "success" : row.cliAdoptionRate >= 20 ? "warning" : "secondary"}>
        {safeNum(row.cliAdoptionRate).toFixed(1)}%
      </Badge>
    ),
  },
];

const teamExportColumns: CSVColumn[] = [
  { key: "teamName", label: "Team" },
  { key: "source", label: "Source" },
  { key: "totalMembers", label: "Members" },
  { key: "avgDailyActiveUsers", label: "Avg Daily Active Users", format: (row) => safeNum(row.avgDailyActiveUsers).toFixed(1) },
  { key: "totalLocAdded", label: "LoC Added" },
  { key: "overallAcceptanceRate", label: "Acceptance %", format: (row) => `${safeNum(row.overallAcceptanceRate).toFixed(1)}%` },
  { key: "agentAdoptionRate", label: "Agent Adoption %", format: (row) => `${safeNum(row.agentAdoptionRate).toFixed(1)}%` },
  { key: "chatAdoptionRate", label: "Chat Adoption %", format: (row) => `${safeNum(row.chatAdoptionRate).toFixed(1)}%` },
  { key: "cliAdoptionRate", label: "CLI Adoption %", format: (row) => `${safeNum(row.cliAdoptionRate).toFixed(1)}%` },
];

export default function TeamsPage() {
  const { selectedEntTeams, selectedOrgTeams, selectedOrgs, hasFilter } = useScope();
  const [totalTeams, setTotalTeams] = useState(0);

  const { buildParams, dateLabel, filenameSuffix } = useDateRangeParams();
  const extraParams = buildParams();
  const allTeams = [...selectedEntTeams, ...selectedOrgTeams];
  if (allTeams.length > 0) extraParams.set("teams", allTeams.join(","));
  if (selectedOrgs.length > 0) extraParams.set("orgs", selectedOrgs.join(","));

  return (
    <div>
      <PageHeader title="Team Analytics" description="Copilot adoption and usage by team">
        <ExportMenu
          csv={{
            fetchUrl: "/api/teams",
            extraParams,
            columns: teamExportColumns,
            dataExtractor: (json) => json.teams ?? [],
            filename: `teams-export-${filenameSuffix}`,
            metadata: {
              reportName: "Team Analytics",
              dateRange: dateLabel,
              teams: extraParams.get("teams") || undefined,
              orgs: extraParams.get("orgs") || undefined,
            },
          }}
        />
      </PageHeader>
      <ScopeFilter />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 mb-8">
        <MetricCard
          title="Total Teams"
          value={totalTeams}
          icon={<Users className="h-4 w-4" />}
          subtitle={hasFilter ? "In selected scope" : "Synced teams"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team Leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          <PaginatedTable<TeamSummary>
            fetchUrl="/api/teams"
            extraParams={extraParams}
            columns={teamColumns}
            defaultSort="totalMembers"
            rowKey={(row) => `${row.source}:${row.teamSlug}`}
            dataExtractor={(json) => (json.teams as TeamSummary[]) ?? []}
            queryKey="teams-table"
            searchable
            searchPlaceholder="Search teams…"
            onTotalChange={setTotalTeams}
          />
        </CardContent>
      </Card>
    </div>
  );
}
