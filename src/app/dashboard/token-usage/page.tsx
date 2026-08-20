"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { Section } from "@/components/ui/Section";
import { Card } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { safeNum } from "@/lib/utils";
import {
  Cpu,
  ArrowDownToLine,
  Database,
  Wallet,
  PiggyBank,
  AlertTriangle,
  Download,
  RefreshCw,
  Info,
} from "lucide-react";
import type {
  TokenKpis,
  TokenModelSummary,
  TokenDailyTrendPoint,
  TokenUserSummary,
  TokenAttribution,
  TokenAttributionRow,
} from "@/lib/types/billing";
import type { CorrelationResult, CacheSavings, Anomaly } from "@/lib/analysis/token-credits";

const TokenTrendChart = dynamic(
  () => import("@/components/charts/TokenTrendChart").then((m) => ({ default: m.TokenTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const TokenPoolSplitChart = dynamic(
  () => import("@/components/charts/TokenPoolSplitChart").then((m) => ({ default: m.TokenPoolSplitChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const TokenCorrelationChart = dynamic(
  () => import("@/components/charts/TokenCorrelationChart").then((m) => ({ default: m.TokenCorrelationChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

interface TokenResponse {
  enabled?: boolean;
  hasTokenData?: boolean;
  kpis?: TokenKpis;
  modelSummary?: TokenModelSummary[];
  dailyTrend?: TokenDailyTrendPoint[];
  topUsers?: TokenUserSummary[];
  attribution?: TokenAttribution;
  correlation?: CorrelationResult;
  cacheSavings?: CacheSavings;
  anomalies?: Anomaly[];
}

const fmtTokens = (v: number) => {
  const n = safeNum(v);
  return n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(2)}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}K`
        : n.toLocaleString();
};

const fmtCurrency = (v: number) => {
  const n = safeNum(v);
  return n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `$${(n / 1_000).toFixed(2)}K`
      : `$${n.toFixed(2)}`;
};

const fmtNum = (v: number, digits = 2) =>
  safeNum(v).toLocaleString(undefined, { maximumFractionDigits: digits });

type ModelSortKey = keyof TokenModelSummary;

/**
 * Token Usage Analytics — per-model token breakdown from the AI usage report,
 * correlated against AI credit consumption (allowance vs. additional) and USD.
 */
export default function TokenUsagePage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();

  const [data, setData] = useState<TokenResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);

  const [modelSort, setModelSort] = useState<ModelSortKey>("total_tokens");
  const [modelSortDir, setModelSortDir] = useState<"asc" | "desc">("desc");
  const [attributionDim, setAttributionDim] = useState<keyof TokenAttribution>("byOrganization");

  const kpiRef = useRef<HTMLDivElement>(null);
  const trendRef = useRef<HTMLDivElement>(null);

  const queryString = useCallback(() => {
    const p = new URLSearchParams();
    p.set("days", String(days));
    buildScopeParams().forEach((v, k) => p.set(k, v));
    return p.toString();
  }, [days, buildScopeParams]);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/tokens?${queryString()}`, { signal });
      const json: TokenResponse & { error?: string } = await res.json();
      if (signal?.aborted) return;
      if (json.enabled === false) {
        setEnabled(false);
        return;
      }
      if (json.error) {
        setError(json.error);
        return;
      }
      setData(json);
    } catch (err) {
      // A superseded request is expected, not a failure to surface.
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      setError(err instanceof Error ? err.message : "Failed to load token usage");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [queryString]);

  // Abort the in-flight request whenever `days` or the scope changes, so a
  // slow earlier response can never overwrite a newer one.
  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const triggerBackfill = useCallback(async () => {
    setBackfilling(true);
    setBackfillMessage(null);
    try {
      const res = await fetch("/api/billing/tokens/backfill", { method: "POST" });
      const json = await res.json();
      setBackfillMessage(
        json.error
          ? `Backfill failed: ${json.error}`
          : json.message || "Billing sync state cleared. Run a sync to refetch token history."
      );
    } catch (err) {
      setBackfillMessage(err instanceof Error ? err.message : "Backfill request failed");
    } finally {
      setBackfilling(false);
    }
  }, []);

  const kpis = data?.kpis;
  const hasTokenData = !!data?.hasTokenData;

  const sortedModels = useMemo(() => {
    const rows = [...(data?.modelSummary ?? [])];
    rows.sort((a, b) => {
      const av = a[modelSort];
      const bv = b[modelSort];
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return modelSortDir === "asc" ? cmp : -cmp;
      }
      const cmp = safeNum(av as number) - safeNum(bv as number);
      return modelSortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data?.modelSummary, modelSort, modelSortDir]);

  const attributionRows: TokenAttributionRow[] = useMemo(
    () => data?.attribution?.[attributionDim] ?? [],
    [data?.attribution, attributionDim]
  );

  const deviantModels = useMemo(
    () =>
      (data?.correlation?.models ?? [])
        .filter((m) => m.deviation !== null && Math.abs(m.deviation) >= 0.25)
        .sort((a, b) => Math.abs(b.deviation ?? 0) - Math.abs(a.deviation ?? 0))
        .slice(0, 8),
    [data?.correlation]
  );

  const handleModelSort = (col: ModelSortKey) => {
    if (modelSort === col) setModelSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setModelSort(col);
      setModelSortDir("desc");
    }
  };

  const ModelHeader = ({ col, label, align = "right" }: { col: ModelSortKey; label: string; align?: "left" | "right" }) => (
    <th
      className={`px-3 py-3 ${align === "left" ? "text-left" : "text-right"} text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider cursor-pointer hover:text-[hsl(var(--foreground))] select-none`}
      onClick={() => handleModelSort(col)}
    >
      <span className={`flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>
        {label}
        {modelSort === col && <span>{modelSortDir === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );

  if (!enabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Token Usage" description="Per-model token breakdown correlated with AI credits and cost" />
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <Cpu className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">
            Enable billing in{" "}
            <code className="text-xs bg-[hsl(var(--accent))] px-1 py-0.5 rounded">dashboard-config.json</code>.
          </p>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Token Usage" description="Per-model token breakdown correlated with AI credits and cost" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <ChartSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  const exportUrl = `/api/export/tokens?${queryString()}`;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Token Usage"
        description="Per-model input, output and cache token volumes, correlated with AI credit and dollar consumption"
      >
        <a
          href={exportUrl}
          className="inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--accent))]"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </a>
      </PageHeader>

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {!hasTokenData && (
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <Info className="h-6 w-6 shrink-0 text-[hsl(var(--muted-foreground))]" />
            <div className="space-y-3">
              <div>
                <h3 className="font-semibold">No token detail available for this range yet</h3>
                <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                  GitHub added a per-model token breakdown (input, output, cache read, cache write) to the AI usage
                  report on 2026-08-11. Rows synced before this dashboard read those columns carry zero tokens. Clear
                  the billing sync state below, then run a sync to refetch the rolling report window with token detail.
                </p>
              </div>
              <button
                onClick={() => void triggerBackfill()}
                disabled={backfilling}
                className="inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-sm hover:bg-[hsl(var(--accent))] disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${backfilling ? "animate-spin" : ""}`} />
                {backfilling ? "Clearing…" : "Refetch billing history"}
              </button>
              {backfillMessage && (
                <p className="text-sm text-[hsl(var(--muted-foreground))]">{backfillMessage}</p>
              )}
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Credit and dollar totals remain available on the{" "}
                <Link href="/dashboard/billing-premium" className="underline">
                  AI Credits
                </Link>{" "}
                page.
              </p>
            </div>
          </div>
        </Card>
      )}

      {hasTokenData && kpis && (
        <>
          <div ref={kpiRef} className="space-y-4">
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <MetricCard
                title="Total Tokens"
                value={fmtTokens(kpis.total_tokens)}
                icon={<Cpu className="h-5 w-5" />}
                accent="violet"
                subtitle={`${fmtNum(kpis.record_count, 0)} report rows`}
                stagger={1}
              />
              <MetricCard
                title="Input Tokens"
                value={fmtTokens(kpis.input_tokens)}
                icon={<ArrowDownToLine className="h-5 w-5" />}
                accent="blue"
                subtitle={`Output ${fmtTokens(kpis.output_tokens)}`}
                stagger={2}
              />
              <MetricCard
                title="Cache Read"
                value={fmtTokens(kpis.cache_read_tokens)}
                icon={<Database className="h-5 w-5" />}
                accent="teal"
                subtitle={`Cache write ${fmtTokens(kpis.cache_write_tokens)}`}
                stagger={3}
              />
              <MetricCard
                title="AI Credits"
                value={fmtNum(kpis.total_credits)}
                icon={<Wallet className="h-5 w-5" />}
                accent="amber"
                subtitle={`${fmtCurrency(kpis.total_gross_usd)} gross`}
                stagger={4}
              />
            </div>

            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <MetricCard
                title="Included Allowance"
                value={fmtNum(kpis.pool_credits)}
                icon={<PiggyBank className="h-5 w-5" />}
                accent="green"
                subtitle={`${fmtCurrency(kpis.pool_usd)} covered`}
              />
              <MetricCard
                title="Additional (Billable)"
                value={fmtNum(kpis.paid_credits)}
                icon={<Wallet className="h-5 w-5" />}
                accent="red"
                subtitle={`${fmtCurrency(kpis.paid_usd)} charged`}
              />
              <MetricCard
                title="Credits per 1M Tokens"
                value={fmtNum(kpis.total_tokens > 0 ? (kpis.total_credits * 1_000_000) / kpis.total_tokens : 0)}
                icon={<Cpu className="h-5 w-5" />}
                accent="violet"
                subtitle={`${kpis.unique_models} models · ${kpis.unique_users} users`}
              />
              <MetricCard
                title="Cache Hit Rate"
                value={
                  kpis.input_tokens + kpis.cache_read_tokens > 0
                    ? `${((kpis.cache_read_tokens * 100) / (kpis.input_tokens + kpis.cache_read_tokens)).toFixed(1)}%`
                    : "—"
                }
                icon={<Database className="h-5 w-5" />}
                accent="teal"
                subtitle="Cache read ÷ (input + cache read)"
              />
            </div>
          </div>

          <Section
            title="Daily Token Volume"
            description="Token classes stacked by day, with AI credits overlaid on the right axis"
          >
            <Card className="p-6" ref={trendRef}>
              <TokenTrendChart data={data?.dailyTrend ?? []} />
            </Card>
          </Section>

          <Section
            title="Allowance vs. Additional Usage"
            description="Credits apportioned by the discount/gross ratio on each report row"
          >
            <Card className="p-6">
              <TokenPoolSplitChart data={data?.dailyTrend ?? []} />
            </Card>
          </Section>

          {data?.cacheSavings && (
            <Section title="Cache Efficiency" description="Estimated savings from prompt caching">
              <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
                <MetricCard
                  title="Cache Hit Rate"
                  value={`${fmtNum(data.cacheSavings.hitRate, 1)}%`}
                  icon={<Database className="h-5 w-5" />}
                  accent="teal"
                  subtitle={`${fmtTokens(data.cacheSavings.cacheReadTokens)} read vs ${fmtTokens(data.cacheSavings.inputTokens)} fresh input`}
                />
                <MetricCard
                  title="Est. Credits Avoided"
                  value={data.cacheSavings.creditsAvoided === null ? "—" : fmtNum(data.cacheSavings.creditsAvoided)}
                  icon={<PiggyBank className="h-5 w-5" />}
                  accent="green"
                  subtitle={
                    data.cacheSavings.creditsAvoided === null
                      ? "Not derivable — the fit does not price cache reads below fresh input"
                      : "Cache reads valued at the fitted input-rate premium"
                  }
                />
                <MetricCard
                  title="Est. Dollars Avoided"
                  value={data.cacheSavings.usdAvoided === null ? "—" : fmtCurrency(data.cacheSavings.usdAvoided)}
                  icon={<Wallet className="h-5 w-5" />}
                  accent="green"
                  subtitle={`At ${fmtNum(data.cacheSavings.usdPerCredit, 6)} USD per credit`}
                />
              </div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Savings are modelled estimates fitted from your own usage, not published GitHub rates.
              </p>
            </Section>
          )}

          <Section
            title="Model Efficiency"
            description="Token volume and credit cost per model. Rates are derived from reported usage."
          >
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-[hsl(var(--border))]">
                  <tr>
                    <ModelHeader col="model" label="Model" align="left" />
                    <ModelHeader col="input_tokens" label="Input" />
                    <ModelHeader col="output_tokens" label="Output" />
                    <ModelHeader col="cache_read_tokens" label="Cache read" />
                    <ModelHeader col="cache_write_tokens" label="Cache write" />
                    <ModelHeader col="total_credits" label="Credits" />
                    <ModelHeader col="credits_per_mtok" label="Credits / 1M" />
                    <ModelHeader col="usd_per_mtok" label="$ / 1M" />
                    <ModelHeader col="output_input_ratio" label="Out:In" />
                    <ModelHeader col="cache_hit_rate" label="Cache hit" />
                    <ModelHeader col="unique_users" label="Users" />
                  </tr>
                </thead>
                <tbody>
                  {sortedModels.map((m) => (
                    <tr key={m.model} className="border-b border-[hsl(var(--border))] last:border-0 hover:bg-[hsl(var(--accent))]">
                      <td className="px-3 py-2 font-medium">{m.model || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(m.input_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(m.output_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(m.cache_read_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(m.cache_write_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(m.total_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(m.credits_per_mtok)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(m.usd_per_mtok)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(m.output_input_ratio, 3)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(m.cache_hit_rate, 1)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.unique_users}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </Section>

          {data?.correlation && data.correlation.points.length > 0 && (
            <Section
              title="Tokens vs. Credits"
              description="Every model/day observation against the implied fleet-average credit rate"
            >
              <Card className="p-6">
                <TokenCorrelationChart
                  points={data.correlation.points}
                  fleetRatesPerMTok={data.correlation.fleetRatesPerMTok}
                  overallR={data.correlation.overallR}
                />
              </Card>
              {deviantModels.length > 0 && (
                <Card className="p-6">
                  <h3 className="mb-3 text-sm font-semibold">Models deviating from their token profile</h3>
                  <ul className="space-y-2 text-sm">
                    {deviantModels.map((m) => (
                      <li key={m.model} className="flex items-center justify-between gap-4">
                        <span className="font-medium">{m.model || "—"}</span>
                        <span className="text-[hsl(var(--muted-foreground))] tabular-nums">
                          {fmtNum(m.observedCreditsPerMTok)} credits/1M ·{" "}
                          <span className={(m.deviation ?? 0) > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}>
                            {(m.deviation ?? 0) > 0 ? "+" : ""}
                            {fmtNum((m.deviation ?? 0) * 100, 0)}% vs fleet
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
                    Deviation compares observed credits against those predicted by the fleet-wide fit over the same
                    token mix. Fitted rates are estimates, not published pricing.
                  </p>
                </Card>
              )}
            </Section>
          )}

          <Section title="Top Consumers" description="Users ranked by total token volume, with their allowance/billable split">
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-[hsl(var(--border))]">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">User</th>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Org</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Total tokens</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Input</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Output</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Cache read</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Credits</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Allowance</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Additional</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Credits / 1M</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.topUsers ?? []).map((u) => (
                    <tr key={`${u.username}::${u.organization}`} className="border-b border-[hsl(var(--border))] last:border-0 hover:bg-[hsl(var(--accent))]">
                      <td className="px-3 py-2 font-medium">{u.username || "—"}</td>
                      <td className="px-3 py-2 text-[hsl(var(--muted-foreground))]">{u.organization || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(u.total_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(u.input_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(u.output_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(u.cache_read_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(u.total_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmtNum(u.pool_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmtNum(u.paid_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(u.credits_per_mtok)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </Section>

          <Section title="Attribution" description="Token and credit consumption by organization, cost center or repository">
            <div className="flex gap-2">
              {([
                ["byOrganization", "Organization"],
                ["byCostCenter", "Cost center"],
                ["byRepository", "Repository"],
              ] as [keyof TokenAttribution, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setAttributionDim(key)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    attributionDim === key
                      ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]"
                      : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-[hsl(var(--border))]">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Name</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Total tokens</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Input</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Cache read</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Credits</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Allowance</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Additional</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Gross USD</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Users</th>
                  </tr>
                </thead>
                <tbody>
                  {attributionRows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-[hsl(var(--muted-foreground))]">
                        No attribution data available
                      </td>
                    </tr>
                  )}
                  {attributionRows.map((r) => (
                    <tr key={r.key || "__unattributed__"} className="border-b border-[hsl(var(--border))] last:border-0 hover:bg-[hsl(var(--accent))]">
                      <td className="px-3 py-2 font-medium">
                        {r.key || <span className="italic text-[hsl(var(--muted-foreground))]">Unattributed</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(r.total_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(r.input_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(r.cache_read_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.total_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmtNum(r.pool_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmtNum(r.paid_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(r.total_gross_usd)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.unique_users}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </Section>

          <Section
            title="Anomalies"
            description="Robust outliers in credits per 1M tokens, plus day-over-day credit spikes"
          >
            <Card className="p-6">
              {(data?.anomalies ?? []).length === 0 ? (
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  No significant outliers detected in this range.
                </p>
              ) : (
                <ul className="space-y-3">
                  {(data?.anomalies ?? []).map((a, i) => (
                    <li key={`${a.kind}-${a.subject}-${a.context ?? ""}-${i}`} className="flex items-start gap-3">
                      <AlertTriangle
                        className={`mt-0.5 h-4 w-4 shrink-0 ${
                          a.direction === "high" ? "text-amber-500" : "text-blue-500"
                        }`}
                      />
                      <div>
                        <p className="text-sm">
                          <span className="font-medium">{a.subject}</span>
                          {a.context && <span className="text-[hsl(var(--muted-foreground))]"> · {a.context}</span>}
                        </p>
                        <p className="text-xs text-[hsl(var(--muted-foreground))]">{a.description}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>
        </>
      )}
    </div>
  );
}
