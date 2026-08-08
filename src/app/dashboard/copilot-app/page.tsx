"use client";

import { useMemo, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton, KPISkeleton } from "@/components/states/ChartSkeleton";
import { Section } from "@/components/ui/Section";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { PaginatedTable, type ColumnDef } from "@/components/tables/PaginatedTable";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { formatNumber } from "@/lib/utils";
import { COPILOT_APP_ROLLUP_NOTE } from "@/lib/constants";
import { Users, TrendingUp, Activity, Send, MessageSquare, Code2, Info, AlertTriangle, Hash } from "lucide-react";
import type { CopilotAppAnalyticsResponse, CopilotAppAdopter } from "@/lib/types/metrics";
import type { CSVColumn } from "@/lib/export/csv";

const CopilotAppAdoptionVolumeChart = dynamic(
  () =>
    import("@/components/charts/CopilotAppAdoptionVolumeChart").then((m) => ({
      default: m.CopilotAppAdoptionVolumeChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const CopilotAppCodeImpactChart = dynamic(
  () =>
    import("@/components/charts/CopilotAppCodeImpactChart").then((m) => ({
      default: m.CopilotAppCodeImpactChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

const adopterColumns: ColumnDef<CopilotAppAdopter>[] = [
  {
    key: "login",
    label: "User",
    render: (row) => (
      <Link
        href={`/dashboard/users/${encodeURIComponent(row.login)}`}
        className="font-medium text-[hsl(var(--primary))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
      >
        {row.login}
      </Link>
    ),
  },
  { key: "activeDays", label: "Active Days", align: "right", render: (row) => row.activeDays.toLocaleString() },
  { key: "sessions", label: "Sessions", align: "right", render: (row) => formatNumber(row.sessions) },
  { key: "requests", label: "Requests", align: "right", render: (row) => formatNumber(row.requests) },
  { key: "prompts", label: "Prompts", align: "right", render: (row) => formatNumber(row.prompts) },
  { key: "promptTokens", label: "Prompt Tokens", align: "right", render: (row) => formatNumber(row.promptTokens) },
  { key: "outputTokens", label: "Output Tokens", align: "right", render: (row) => formatNumber(row.outputTokens) },
  { key: "locAdded", label: "LoC Added", align: "right", render: (row) => formatNumber(row.locAdded) },
  { key: "locDeleted", label: "LoC Deleted", align: "right", render: (row) => formatNumber(row.locDeleted) },
];

const adopterExportColumns: CSVColumn[] = [
  { key: "login", label: "User" },
  { key: "activeDays", label: "Active Days" },
  { key: "sessions", label: "Sessions" },
  { key: "requests", label: "Requests" },
  { key: "prompts", label: "Prompts" },
  { key: "promptTokens", label: "Prompt Tokens" },
  { key: "outputTokens", label: "Output Tokens" },
  { key: "locAdded", label: "LoC Added" },
  { key: "locDeleted", label: "LoC Deleted" },
];

async function fetchCopilotAppSummary(url: string): Promise<CopilotAppAnalyticsResponse> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Copilot App Analytics — dedicated page for adoption, usage volume, and
 * engineering output attributable to the Copilot App surface. Renders three
 * response shapes distinctly (see {@link CopilotAppAnalyticsResponse}):
 * precise user-level data, an enterprise/organization aggregate fallback
 * (KPIs/trends only, no adopters or breakdowns), and the "no data" state for
 * date ranges that predate the July 28, 2026 rollout.
 */
export default function CopilotAppPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();

  const scopeParams = buildScopeParams();
  const scopeParamsKey = scopeParams.toString();

  // Memoized once per (days, scope) pair — never mutated after creation, so
  // it stays a stable reference for PaginatedTable's extraParams and the
  // CSV export config across renders.
  const summaryParams = useMemo(() => {
    const params = new URLSearchParams(scopeParamsKey);
    params.set("days", String(days));
    return params;
  }, [days, scopeParamsKey]);

  const kpiRef = useRef<HTMLDivElement>(null);
  const adoptionRef = useRef<HTMLDivElement>(null);
  const codeImpactRef = useRef<HTMLDivElement>(null);
  const compositionRef = useRef<HTMLDivElement>(null);
  const adoptersRef = useRef<HTMLDivElement>(null);

  const summaryParamsString = summaryParams.toString();

  const { data, isLoading, error, refetch } = useQuery<CopilotAppAnalyticsResponse>({
    queryKey: ["copilot-app-summary", days, scopeParamsKey],
    queryFn: () => fetchCopilotAppSummary(`/api/metrics/copilot-app?${summaryParamsString}`),
  });

  const hasCopilotAppData = data?.hasCopilotAppData ?? false;
  const capabilities = data?.capabilities;
  const isAggregateFallback = hasCopilotAppData && (data?.dataSource === "enterprise" || data?.dataSource === "organization");
  const showAdopters = hasCopilotAppData && Boolean(capabilities?.adopters);

  if (isLoading && !data) {
    return (
      <div>
        <PageHeader title="Copilot App Analytics" description="Loading Copilot App metrics..." />
        <ScopeFilter />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <KPISkeleton key={i} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Copilot App Analytics" description="Adoption, usage volume, and code impact from the Copilot App surface" />
        <ScopeFilter />
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <AlertTriangle className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error loading data</h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto mb-4">
            {error instanceof Error ? error.message : "Failed to load Copilot App metrics."}
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-sm font-medium text-[hsl(var(--primary))] hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data || !hasCopilotAppData) {
    return (
      <div>
        <PageHeader title="Copilot App Analytics" description="Adoption, usage volume, and code impact from the Copilot App surface" />
        <ScopeFilter />
        <div
          className="mb-6 flex items-start gap-2 rounded-lg border border-amber-300/60 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
          role="note"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{COPILOT_APP_ROLLUP_NOTE.message}</span>
        </div>
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <Code2 className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Copilot App data</h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">
            No Copilot App metrics are present in the selected synced range. Try a range on or after{" "}
            {COPILOT_APP_ROLLUP_NOTE.effectiveDate}, or a broader scope.
          </p>
        </div>
      </div>
    );
  }

  const { kpis, adoptionTrend, codeImpactTrend, modelBreakdown, languageBreakdown } = data;

  return (
    <div>
      <PageHeader
        title="Copilot App Analytics"
        description="Adoption, usage volume, and code impact from the Copilot App surface"
      >
        <ExportMenu
          csv={
            showAdopters
              ? {
                  fetchUrl: "/api/metrics/copilot-app/adopters",
                  extraParams: summaryParams,
                  columns: adopterExportColumns,
                  dataExtractor: (json) => json.adopters ?? [],
                  filename: `copilot-app-adopters-${days}d`,
                  metadata: {
                    reportName: "Copilot App Adopters",
                    dateRange: `Last ${days} days`,
                    teams: scopeParams.get("teams") ?? undefined,
                    orgs: scopeParams.get("orgs") ?? undefined,
                  },
                }
              : undefined
          }
          pdf={{
            sectionRefs: showAdopters
              ? [kpiRef, adoptionRef, codeImpactRef, compositionRef, adoptersRef]
              : [kpiRef, adoptionRef, codeImpactRef, compositionRef],
            title: "Copilot App Analytics",
            filename: `copilot-app-analytics-${days}d`,
            metadata: {
              reportName: "Copilot App Analytics",
              dateRange: `Last ${days} days`,
              teams: scopeParams.get("teams") ?? undefined,
              orgs: scopeParams.get("orgs") ?? undefined,
            },
          }}
          isReady={!isLoading && hasCopilotAppData}
        />
      </PageHeader>

      <ScopeFilter />

      {/* Rollout/coverage caveat — App attribution only exists from the effective date onward */}
      <div
        className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300/60 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
        role="note"
        title={COPILOT_APP_ROLLUP_NOTE.message}
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{COPILOT_APP_ROLLUP_NOTE.message}</span>
      </div>

      {/* Aggregate fallback caveat — user attribution isn't available for this scope/source */}
      {isAggregateFallback && (
        <div
          className="mb-6 flex items-start gap-2 rounded-lg border border-blue-300/60 dark:border-blue-700/50 bg-blue-50 dark:bg-blue-950/30 px-4 py-2.5 text-sm text-blue-800 dark:text-blue-300"
          role="note"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            User-attributed App data is unavailable for this scope — showing {data.dataSource} aggregate
            totals instead. Adopter, model, and language breakdowns require user-level data.
          </span>
        </div>
      )}

      {/* KPI Cards */}
      <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
        <MetricCard
          title="App Active Users"
          value={kpis.appActiveUsers}
          icon={<Users className="h-4 w-4" />}
          subtitle={`${days}-day window`}
        />
        <MetricCard
          title="App Adoption"
          value={kpis.adoptionRate}
          format="percent"
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle="Of period-active Copilot users"
        />
        <MetricCard
          title="Sessions"
          value={kpis.sessions}
          icon={<Activity className="h-4 w-4" />}
        />
        <MetricCard
          title="Requests"
          value={kpis.requests}
          icon={<Send className="h-4 w-4" />}
        />
        <MetricCard
          title="Prompts"
          value={kpis.prompts}
          icon={<MessageSquare className="h-4 w-4" />}
        />
        <MetricCard
          title="App LoC Changed"
          value={kpis.locChanged}
          icon={<Code2 className="h-4 w-4" />}
          subtitle={`${formatNumber(kpis.locAdded)} added / ${formatNumber(kpis.locDeleted)} deleted`}
        />
      </div>

      {/* Trends */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
        <div ref={adoptionRef}>
          <CopilotAppAdoptionVolumeChart data={adoptionTrend} />
        </div>
        <div ref={codeImpactRef}>
          <CopilotAppCodeImpactChart data={codeImpactTrend} />
        </div>
      </div>

      {/* Composition — App-only model/language breakdown plus token totals */}
      <div ref={compositionRef}>
        <Section title="Composition" description="App-only model and language interactions, and token usage per request" className="mb-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-4">
            <Card>
              <CardHeader>
                <CardTitle>Model Interactions</CardTitle>
              </CardHeader>
              <CardContent>
                {capabilities?.modelBreakdown ? (
                  modelBreakdown.length > 0 ? (
                    <ul className="space-y-2">
                      {modelBreakdown.map((row) => (
                        <li key={row.name} className="flex items-center justify-between text-sm">
                          <span className="truncate">{row.name}</span>
                          <span className="tabular-nums text-[hsl(var(--muted-foreground))]">
                            {formatNumber(row.interactions)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-[hsl(var(--muted-foreground))]">
                      No App model interactions in this range.
                    </p>
                  )
                ) : (
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    Model breakdown requires user-level App data, which is unavailable for this scope.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Language Activity</CardTitle>
              </CardHeader>
              <CardContent>
                {capabilities?.languageBreakdown ? (
                  languageBreakdown.length > 0 ? (
                    <ul className="space-y-2">
                      {languageBreakdown.map((row) => (
                        <li key={row.name} className="flex items-center justify-between text-sm">
                          <span className="truncate">{row.name}</span>
                          <span className="tabular-nums text-[hsl(var(--muted-foreground))]">
                            {formatNumber(row.interactions)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-[hsl(var(--muted-foreground))]">
                      No App language activity in this range.
                    </p>
                  )
                ) : (
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    Language breakdown requires user-level App data, which is unavailable for this scope.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MetricCard
              title="Prompt Tokens"
              value={kpis.promptTokens}
              icon={<MessageSquare className="h-4 w-4" />}
              subtitle={`${days}-day total`}
            />
            <MetricCard
              title="Output Tokens"
              value={kpis.outputTokens}
              icon={<Send className="h-4 w-4" />}
              subtitle={`${days}-day total`}
            />
            <MetricCard
              title="Weighted Tokens / Request"
              value={kpis.avgTokensPerRequest}
              format="raw"
              icon={<Hash className="h-4 w-4" />}
              subtitle="(Prompt + output) ÷ requests"
            />
          </div>
        </Section>
      </div>

      {/* Adopters — user-level roster, only when capabilities support it */}
      {showAdopters && (
        <div ref={adoptersRef}>
          <Section title="Top Copilot App Adopters" className="mb-6">
            <Card>
              <CardContent className="pt-6">
                <PaginatedTable<CopilotAppAdopter>
                  fetchUrl="/api/metrics/copilot-app/adopters"
                  extraParams={summaryParams}
                  columns={adopterColumns}
                  defaultSort="sessions"
                  defaultSortDir="desc"
                  rowKey={(row) => row.login}
                  dataExtractor={(json) => (json.adopters as CopilotAppAdopter[]) ?? []}
                  queryKey="copilot-app-adopters"
                  searchable
                  searchPlaceholder="Search App adopters..."
                />
              </CardContent>
            </Card>
          </Section>
        </div>
      )}

      {/* Related Analytics */}
      <section className="mt-8 pt-6 border-t">
        <h3 className="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Related Analytics</h3>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/models" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Model Statistics →
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
