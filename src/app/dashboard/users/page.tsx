"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Users } from "lucide-react";
import { PaginatedTable, type ColumnDef } from "@/components/tables/PaginatedTable";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { DateFilter } from "@/components/filters/DateFilter";
import type { CSVColumn } from "@/lib/export/csv";
import { formatNumber, safeNum } from "@/lib/utils";

interface UserRow {
  login: string;
  activeDays: number;
  locAdded: number;
  locDeleted: number;
  interactions: number;
  aiCreditsUsed: number;
  codeGen: number;
  codeAccept: number;
  acceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReviewActive: boolean;
  usedCodeReviewPassive: boolean;
  usedCodingAgent: boolean;
}

const userColumns: ColumnDef<UserRow>[] = [
  { key: "login", label: "User", render: (row) => (
    <div className="flex items-center gap-2">
      <Link href={`/dashboard/users/${row.login}`} className="font-medium text-[hsl(var(--primary))] hover:underline">
        {row.login}
      </Link>
      {row.activeDays === 0 && <Badge variant="secondary">Inactive</Badge>}
    </div>
  ) },
  { key: "activeDays", label: "Active Days", align: "right", render: (row) => row.activeDays },
  { key: "locAdded", label: "LoC Added", align: "right", render: (row) => formatNumber(row.locAdded) },
  { key: "interactions", label: "Interactions", align: "right", render: (row) => formatNumber(row.interactions) },
  { key: "aiCreditsUsed", label: "AI Credits", align: "right", render: (row) => safeNum(row.aiCreditsUsed) > 0 ? safeNum(row.aiCreditsUsed).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—" },
  { key: "acceptanceRate", label: "Accept %", align: "right", render: (row) => `${safeNum(row.acceptanceRate).toFixed(1)}%` },
  {
    key: "features",
    label: "Features",
    sortable: false,
    render: (row) => (
      <div className="flex gap-1 flex-wrap">
        {row.usedAgent && <Badge variant="default">Agent</Badge>}
        {row.usedCodingAgent && <Badge variant="default">Coding Agent</Badge>}
        {row.usedChat && <Badge variant="secondary">Chat</Badge>}
        {row.usedCli && <Badge variant="success">CLI</Badge>}
        {row.usedCodeReviewActive && <Badge variant="warning">Review (Active)</Badge>}
        {!row.usedCodeReviewActive && row.usedCodeReviewPassive && <Badge variant="secondary">Review (Passive)</Badge>}
      </div>
    ),
  },
];

const userExportColumns: CSVColumn[] = [
  { key: "login", label: "User" },
  { key: "activeDays", label: "Active Days" },
  { key: "locAdded", label: "LoC Added" },
  { key: "interactions", label: "Interactions" },
  { key: "aiCreditsUsed", label: "AI Credits Used", format: (row) => safeNum(row.aiCreditsUsed).toFixed(2) },
  { key: "acceptanceRate", label: "Acceptance %", format: (row) => `${safeNum(row.acceptanceRate).toFixed(1)}%` },
  {
    key: "features", label: "Features", format: (row) => {
      const f: string[] = [];
      if (row.usedAgent) f.push("Agent");
      if (row.usedCodingAgent) f.push("Coding Agent");
      if (row.usedChat) f.push("Chat");
      if (row.usedCli) f.push("CLI");
      if (row.usedCodeReviewActive) f.push("Code Review (Active)");
      else if (row.usedCodeReviewPassive) f.push("Code Review (Passive)");
      return f.join(", ");
    },
  },
];

export default function UsersPage() {
  const { mode, days, startDate, endDate } = useDateRange();
  const { hasFilter, buildScopeParams } = useScope();
  const [totalUsers, setTotalUsers] = useState(0);
  const [includeInactive, setIncludeInactive] = useState(false);

  const extraParams = new URLSearchParams();
  if (mode === "custom") {
    extraParams.set("startDate", startDate);
    extraParams.set("endDate", endDate);
  } else {
    extraParams.set("days", String(days));
  }
  if (includeInactive) extraParams.set("includeInactive", "true");
  const scopeParams = buildScopeParams();
  scopeParams.forEach((v, k) => extraParams.set(k, v));

  const dateLabel = mode === "custom" ? `${startDate} to ${endDate}` : `Last ${days} days`;

  return (
    <div>
      <PageHeader title="User Explorer" description="Individual developer Copilot usage">
        <ExportMenu
          csv={{
            fetchUrl: "/api/users",
            extraParams,
            columns: userExportColumns,
            dataExtractor: (json) => json.users ?? [],
            filename: `users-export-${mode === "custom" ? `${startDate}_${endDate}` : `${days}d`}`,
            metadata: {
              reportName: "User Explorer",
              dateRange: dateLabel,
              teams: scopeParams.get("teams") || undefined,
              orgs: scopeParams.get("orgs") || undefined,
            },
          }}
        />
      </PageHeader>
      <ScopeFilter />
      <DateFilter />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 mb-8">
        <MetricCard
          title="Total Users"
          value={totalUsers}
          icon={<Users className="h-4 w-4" />}
          subtitle={hasFilter ? "In selected scope" : "With activity in period"}
        />
      </div>

      <div className="flex items-center gap-2 mb-4">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span className="text-[hsl(var(--muted-foreground))]">Include inactive seat holders</span>
        </label>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
        </CardHeader>
        <CardContent>
          <PaginatedTable<UserRow>
            fetchUrl="/api/users"
            extraParams={extraParams}
            columns={userColumns}
            defaultSort="activeDays"
            rowKey={(row) => row.login}
            dataExtractor={(json) => (json.users as UserRow[]) ?? []}
            queryKey="users-table"
            searchable
            searchPlaceholder="Search users…"
            onTotalChange={setTotalUsers}
          />
        </CardContent>
      </Card>
    </div>
  );
}
