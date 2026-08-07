"use client";

import Link from "next/link";
import { CreditCard, Zap } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { DateFilter } from "@/components/filters/DateFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { PaginatedTable, type ColumnDef } from "@/components/tables/PaginatedTable";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { safeNum } from "@/lib/utils";
import { useState } from "react";

interface AiCreditsUserRow {
  user_login: string;
  total_ai_credits_used: number;
  active_days: number;
  avg_daily_ai_credits: number;
  last_active_day: string;
}

const formatCredits = (value: number) =>
  safeNum(value).toLocaleString(undefined, { maximumFractionDigits: 2 });

const columns: ColumnDef<AiCreditsUserRow>[] = [
  {
    key: "user_login",
    label: "User",
    render: (row) => (
      <Link
        href={`/dashboard/users/${row.user_login}`}
        className="font-medium text-[hsl(var(--primary))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
      >
        {row.user_login}
      </Link>
    ),
  },
  {
    key: "total_ai_credits_used",
    label: "AI Credits",
    align: "right",
    render: (row) => formatCredits(row.total_ai_credits_used),
  },
  {
    key: "active_days",
    label: "Active Days",
    align: "right",
    render: (row) => row.active_days.toLocaleString(),
  },
  {
    key: "avg_daily_ai_credits",
    label: "Avg / Active Day",
    align: "right",
    render: (row) => formatCredits(row.avg_daily_ai_credits),
  },
  {
    key: "last_active_day",
    label: "Last Active",
    align: "right",
    render: (row) => row.last_active_day,
  },
];

const exportColumns = [
  { key: "user_login", label: "User" },
  {
    key: "total_ai_credits_used",
    label: "AI Credits Used",
    format: (row: AiCreditsUserRow) => safeNum(row.total_ai_credits_used).toFixed(2),
  },
  { key: "active_days", label: "Active Days" },
  {
    key: "avg_daily_ai_credits",
    label: "Average Daily AI Credits",
    format: (row: AiCreditsUserRow) => safeNum(row.avg_daily_ai_credits).toFixed(2),
  },
  { key: "last_active_day", label: "Last Active Day" },
];

/**
 * Renders a sortable per-user AI Credit consumption dashboard.
 */
export default function AiCreditsUsersPage() {
  const { mode, days, startDate, endDate } = useDateRange();
  const { hasFilter, buildScopeParams } = useScope();
  const [totalUsers, setTotalUsers] = useState(0);

  const extraParams = new URLSearchParams();
  if (mode === "custom") {
    extraParams.set("startDate", startDate);
    extraParams.set("endDate", endDate);
  } else {
    extraParams.set("days", String(days));
  }
  const scopeParams = buildScopeParams();
  scopeParams.forEach((value, key) => extraParams.set(key, value));

  const dateLabel = mode === "custom" ? `${startDate} to ${endDate}` : `Last ${days} days`;

  return (
    <div>
      <PageHeader
        title="AI Credits by User"
        description="Sortable user-level AI credit consumption from the Usage Metrics API"
      >
        <ExportMenu
          csv={{
            fetchUrl: "/api/billing/ai-credits/users",
            extraParams,
            columns: exportColumns,
            dataExtractor: (json) => json.users ?? [],
            filename: `ai-credits-users-${mode === "custom" ? `${startDate}_${endDate}` : `${days}d`}`,
            metadata: {
              reportName: "AI Credits by User",
              dateRange: dateLabel,
              teams: scopeParams.get("teams") || undefined,
              orgs: scopeParams.get("orgs") || undefined,
            },
          }}
        />
      </PageHeader>
      <ScopeFilter />
      <DateFilter />

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          title="Users with AI Credits"
          value={totalUsers}
          icon={<CreditCard className="h-4 w-4" />}
          subtitle={hasFilter ? "In selected scope" : dateLabel}
        />
        <MetricCard
          title="Metric Source"
          value="Usage API"
          format="raw"
          icon={<Zap className="h-4 w-4" />}
          subtitle="user_daily_metrics.ai_credits_used"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>User AI Credit Consumption</CardTitle>
        </CardHeader>
        <CardContent>
          <PaginatedTable<AiCreditsUserRow>
            fetchUrl="/api/billing/ai-credits/users"
            extraParams={extraParams}
            columns={columns}
            defaultSort="total_ai_credits_used"
            rowKey={(row) => row.user_login}
            dataExtractor={(json) => (json.users as AiCreditsUserRow[]) ?? []}
            queryKey="ai-credits-users-table"
            searchable
            searchPlaceholder="Search users..."
            onTotalChange={setTotalUsers}
          />
        </CardContent>
      </Card>
    </div>
  );
}
