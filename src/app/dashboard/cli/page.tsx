"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { CSVColumn } from "@/lib/export/csv";

const CLIUsersTrendChart = dynamic(
  () => import("@/components/charts/CLIUsersTrendChart").then(m => ({ default: m.CLIUsersTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const CLITokenChart = dynamic(
  () => import("@/components/charts/CLITokenChart").then(m => ({ default: m.CLITokenChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
import Link from "next/link";
import { Terminal, Activity, Zap, Hash, Code2, GitBranch, AlertTriangle } from "lucide-react";
import { formatNumber } from "@/lib/utils";
import { useTableSort } from "@/hooks/useTableSort";
import { SortableHeader } from "@/components/tables/SortableHeader";

interface DailyTrendDay {
  day: string;
  cliUsers: number;
  ideUsers: number;
}

interface DailyTokenDay {
  day: string;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  avgPerRequest: number;
}

interface CLIUser {
  login: string;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  days: number;
}

interface CLIVersionEntry {
  version: string;
  users: number;
}

interface CLISuggestion {
  locSuggestedAdd: number;
  locSuggestedDelete: number;
  locAdded: number;
  locDeleted: number;
  acceptanceRate: number;
}

interface CLIData {
  dailyTrend: DailyTrendDay[];
  dailyTokens: DailyTokenDay[];
  kpis: {
    dailyCliUsers: number;
    sessionsToday: number;
    requestsToday: number;
    avgTokensPerRequest: number;
  };
  cliSuggestion?: CLISuggestion;
  cliVersions?: CLIVersionEntry[];
  outdatedCliUsers?: number;
  minReliableCliVersion?: string;
  topCliUsers: CLIUser[];
}

const cliUserExportColumns: CSVColumn[] = [
  { key: "login", label: "User" },
  { key: "sessions", label: "Sessions" },
  { key: "requests", label: "Requests" },
  { key: "promptTokens", label: "Prompt Tokens" },
  { key: "outputTokens", label: "Output Tokens" },
  { key: "days", label: "Active Days" },
];

export default function CLIPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<CLIData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const versionsRef = useRef<HTMLDivElement>(null);

  const fetchData= useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ days: String(days) });
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => params.set(k, v));

    fetch(`/api/metrics/cli?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, buildScopeParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  type CLISortField = "login" | "sessions" | "requests" | "promptTokens" | "outputTokens" | "days";
  const { sortedData: sortedCliUsers, sortField: cliSortField, sortAsc: cliSortAsc, handleSort: handleCliSort } = useTableSort<CLIUser, CLISortField>(data?.topCliUsers ?? [], "sessions");

  if (loading) {
    return (
      <div>
        <PageHeader title="CLI Analytics" description="CLI session activity, user counts, and token consumption" />
        <div className="flex h-64 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          Loading CLI metrics…
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="CLI Analytics" description="CLI session activity, user counts, and token consumption" />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const tokenChartData = data.dailyTokens.map((d) => ({
    day: d.day,
    promptTokens: d.promptTokens,
    outputTokens: d.outputTokens,
    avgPerRequest: d.avgPerRequest,
  }));

  const suggestion = data.cliSuggestion;
  const cliVersions = data.cliVersions ?? [];
  const outdatedCliUsers = data.outdatedCliUsers ?? 0;
  const minReliableCliVersion = data.minReliableCliVersion ?? "1.0.64";
  const hasSuggestionData = !!suggestion && (suggestion.locSuggestedAdd > 0 || suggestion.locAdded > 0);

  return (
    <div>
      <PageHeader
        title="CLI Analytics"
        description="CLI session activity, user counts, and token consumption"
      >
        <ExportMenu
          csv={{
            fetchUrl: "/api/metrics/cli",
            extraParams: new URLSearchParams({ days: String(days), ...Object.fromEntries(buildScopeParams()) }),
            columns: cliUserExportColumns,
            dataExtractor: (json) => json.topCliUsers ?? [],
            filename: `cli-users-export-${days}d`,
            metadata: {
              reportName: "CLI Analytics — Top Users",
              dateRange: `Last ${days} days`,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          pdf={{
            sectionRefs: [kpiRef, chartsRef, versionsRef, tableRef],
            title: "CLI Analytics",
            filename: `cli-report-${days}d`,
            metadata: {
              reportName: "CLI Analytics",
              dateRange: `Last ${days} days`,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* KPI Cards */}
      <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="Daily CLI Users"
          value={data.kpis.dailyCliUsers}
          icon={<Terminal className="h-4 w-4" />}
          subtitle="Latest day"
        />
        <MetricCard
          title="Sessions Today"
          value={data.kpis.sessionsToday}
          icon={<Activity className="h-4 w-4" />}
          subtitle="Latest day"
        />
        <MetricCard
          title="Requests Today"
          value={data.kpis.requestsToday}
          icon={<Zap className="h-4 w-4" />}
          subtitle="Latest day"
        />
        <MetricCard
          title="Avg Tokens/Request"
          value={data.kpis.avgTokensPerRequest}
          icon={<Hash className="h-4 w-4" />}
          subtitle="Latest day"
        />
      </div>

      {/* Charts */}
      <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
        <CLIUsersTrendChart data={data.dailyTrend} />
        <CLITokenChart data={tokenChartData} />
      </div>

      {/* Code suggestion effectiveness + version adoption */}
      <div ref={versionsRef} className="mb-6">
        {/* Code suggestion KPIs (Insight B) */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-4">
          <MetricCard
            title="CLI LoC Suggested"
            value={hasSuggestionData ? suggestion!.locSuggestedAdd : "—"}
            icon={<Code2 className="h-4 w-4" />}
            subtitle="Lines suggested to add"
          />
          <MetricCard
            title="CLI LoC Accepted"
            value={hasSuggestionData ? suggestion!.locAdded : "—"}
            icon={<Code2 className="h-4 w-4" />}
            subtitle="Lines added"
          />
          <MetricCard
            title="CLI LoC Acceptance"
            value={hasSuggestionData ? `${suggestion!.acceptanceRate.toFixed(1)}%` : "—"}
            icon={<Activity className="h-4 w-4" />}
            subtitle="Added ÷ suggested"
          />
        </div>
        <p className="mb-6 text-xs text-[hsl(var(--muted-foreground))]">
          CLI suggested-LoC is only reliable on Copilot CLI 1.0.57+ and de-duplicated on 1.0.64+.
          Older versions may under-report and are shown as “—” when no data is available.
        </p>

        {/* Outdated CLI callout (Insight A) */}
        {outdatedCliUsers > 0 && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              <strong>{formatNumber(outdatedCliUsers)}</strong> user{outdatedCliUsers === 1 ? "" : "s"} on
              an outdated CLI (&lt;{minReliableCliVersion}). Outdated CLI versions degrade metric quality —
              encourage upgrading for accurate suggested-LoC reporting.
            </span>
          </div>
        )}

        {/* CLI versions table (Insight A) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" /> CLI Versions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {cliVersions.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
                No CLI version data available
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                      <th className="py-2 pr-4 font-medium">Version</th>
                      <th className="py-2 text-right font-medium">Users</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cliVersions.slice(0, 20).map((v) => (
                      <tr key={v.version} className="border-b last:border-0">
                        <td className="py-3 pr-4 font-medium">{v.version}</td>
                        <td className="py-3 text-right">{formatNumber(v.users)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top CLI Users Table */}
      <Card ref={tableRef}>
        <CardHeader>
          <CardTitle>Top CLI Users</CardTitle>
        </CardHeader>
        <CardContent>
          {data.topCliUsers.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              No CLI user data available
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                    <SortableHeader label="User" field={"login" as CLISortField} sortField={cliSortField} sortAsc={cliSortAsc} onSort={handleCliSort} />
                    <SortableHeader label="Sessions" field={"sessions" as CLISortField} sortField={cliSortField} sortAsc={cliSortAsc} onSort={handleCliSort} align="right" />
                    <SortableHeader label="Requests" field={"requests" as CLISortField} sortField={cliSortField} sortAsc={cliSortAsc} onSort={handleCliSort} align="right" />
                    <SortableHeader label="Prompt Tokens" field={"promptTokens" as CLISortField} sortField={cliSortField} sortAsc={cliSortAsc} onSort={handleCliSort} align="right" />
                    <SortableHeader label="Output Tokens" field={"outputTokens" as CLISortField} sortField={cliSortField} sortAsc={cliSortAsc} onSort={handleCliSort} align="right" />
                    <SortableHeader label="Active Days" field={"days" as CLISortField} sortField={cliSortField} sortAsc={cliSortAsc} onSort={handleCliSort} align="right" last />
                  </tr>
                </thead>
                <tbody>
                  {sortedCliUsers.map((user) => (
                    <tr key={user.login} className="border-b last:border-0">
                      <td className="py-3 pr-4 font-medium">{user.login}</td>
                      <td className="py-3 pr-4 text-right">{formatNumber(user.sessions)}</td>
                      <td className="py-3 pr-4 text-right">{formatNumber(user.requests)}</td>
                      <td className="py-3 pr-4 text-right">{formatNumber(user.promptTokens)}</td>
                      <td className="py-3 pr-4 text-right">{formatNumber(user.outputTokens)}</td>
                      <td className="py-3 text-right">{user.days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Related Analytics */}
      <section className="mt-8 pt-6 border-t">
        <h3 className="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Related Analytics</h3>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/chat-modes" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Copilot Features →
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
