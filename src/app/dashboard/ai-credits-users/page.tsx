"use client";

import Link from "next/link";
import { Bot, CreditCard, Users, Zap } from "lucide-react";
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
import { useEffect, useState } from "react";

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

interface Reconciliation {
  attributedCredits: number;
  unattributedCredits: number;
  totalBilledCredits: number;
  attributedUsers: number;
  unattributedByModel: { model: string; credits: number }[];
  billingThrough: string | null;
}

/**
 * Renders a sortable per-user AI Credit consumption dashboard.
 */
export default function AiCreditsUsersPage() {
  const { mode, days, startDate, endDate } = useDateRange();
  const { hasFilter, buildScopeParams } = useScope();
  const [totalUsers, setTotalUsers] = useState(0);
  const [metricsCredits, setMetricsCredits] = useState<number | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);

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

  const queryString = extraParams.toString();
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/billing/ai-credits/users?${queryString}&pageSize=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return;
        setMetricsCredits(json.totals?.total_ai_credits_used ?? null);
        setRecon(json.reconciliation ?? null);
      })
      .catch(() => {
        /* Reconciliation is supplementary; the table below still works. */
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  const topSurfaces = recon?.unattributedByModel.slice(0, 2).map((m) => m.model).join(", ");

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

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Attributed to Users"
          value={recon ? formatCredits(recon.attributedCredits) : "—"}
          format="raw"
          icon={<Zap className="h-4 w-4" />}
          accent="violet"
          subtitle={recon ? `Across ${recon.attributedUsers} developers` : "Billing report"}
        />
        <MetricCard
          title="Unattributed"
          value={recon ? formatCredits(recon.unattributedCredits) : "—"}
          format="raw"
          icon={<Bot className="h-4 w-4" />}
          accent="amber"
          subtitle={topSurfaces ? `Mostly ${topSurfaces}` : "No user attribution"}
        />
        <MetricCard
          title="Total Billed"
          value={recon ? formatCredits(recon.totalBilledCredits) : "—"}
          format="raw"
          icon={<CreditCard className="h-4 w-4" />}
          accent="blue"
          subtitle={recon?.billingThrough ? `Billed through ${recon.billingThrough}` : dateLabel}
        />
        <MetricCard
          title="Users with AI Credits"
          value={totalUsers}
          icon={<Users className="h-4 w-4" />}
          accent="teal"
          subtitle={hasFilter ? "In selected scope" : dateLabel}
        />
      </div>

      {recon && recon.unattributedCredits > 0 && (
        <div
          role="note"
          className="mb-8 space-y-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 px-4 py-3 text-sm text-[hsl(var(--muted-foreground))]"
        >
          <p>
            <strong className="text-[hsl(var(--foreground))]">
              {formatCredits(recon.attributedCredits)}
            </strong>{" "}
            attributed{" "}
            <span aria-hidden="true">+</span>
            <span className="sr-only">plus</span>{" "}
            <strong className="text-[hsl(var(--foreground))]">
              {formatCredits(recon.unattributedCredits)}
            </strong>{" "}
            unattributed{" "}
            <span aria-hidden="true">=</span>
            <span className="sr-only">equals</span>{" "}
            <strong className="text-[hsl(var(--foreground))]">
              {formatCredits(recon.totalBilledCredits)}
            </strong>{" "}
            total, the same figure shown on{" "}
            <Link
              href="/dashboard/token-usage"
              className="text-[hsl(var(--primary))] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              Token Usage
            </Link>{" "}
            and{" "}
            <Link
              href="/dashboard/billing-premium"
              className="text-[hsl(var(--primary))] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              AI Credits
            </Link>
            . The unattributed portion is billed to the enterprise rather than to a
            developer — automated surfaces such as{" "}
            {recon.unattributedByModel.slice(0, 3).map((m) => m.model).join(", ")} — so it
            can never appear in the table below.
          </p>
          {metricsCredits !== null && (
            <p>
              The table itself sums to{" "}
              <strong className="text-[hsl(var(--foreground))]">
                {formatCredits(metricsCredits)}
              </strong>
              , measured by the Usage Metrics API rather than the billing report. The two
              agree per user; any remaining difference is reporting lag between the
              sources
              {recon.billingThrough ? `, with billing current through ${recon.billingThrough}` : ""}.
            </p>
          )}
        </div>
      )}

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
