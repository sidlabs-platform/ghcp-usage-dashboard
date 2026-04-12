"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { CHART_COLORS } from "@/lib/constants";
import { Monitor, Code2, Languages, TrendingUp } from "lucide-react";
import { ExportMenu } from "@/components/ui/ExportMenu";

interface IDEEntry {
  name: string;
  locAdded: number;
  locDeleted: number;
  interactions: number;
  generations: number;
  acceptances: number;
}

interface LanguageEntry {
  name: string;
  locAdded: number;
  locDeleted: number;
  generations: number;
  acceptances: number;
}

interface IDELangData {
  ideDistribution: IDEEntry[];
  languageDistribution: LanguageEntry[];
  ideTrend: Record<string, string | number>[];
  allIdes: string[];
}

const DONUT_COLORS = [
  CHART_COLORS.vscode,
  CHART_COLORS.jetbrains,
  CHART_COLORS.xcode,
  CHART_COLORS.neovim,
  CHART_COLORS.visualStudio,
  CHART_COLORS.primary,
  CHART_COLORS.secondary,
  CHART_COLORS.success,
  CHART_COLORS.warning,
  CHART_COLORS.info,
];

const TREND_COLORS = [
  CHART_COLORS.vscode,
  CHART_COLORS.jetbrains,
  CHART_COLORS.xcode,
  CHART_COLORS.neovim,
  CHART_COLORS.visualStudio,
  CHART_COLORS.primary,
  CHART_COLORS.secondary,
  CHART_COLORS.info,
];

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function IDELanguagesPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<IDELangData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ days: String(days) });
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => params.set(k, v));

    fetch(`/api/metrics/ide-languages?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, buildScopeParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div>
        <PageHeader title="IDE & Languages" description="Editor and programming language usage breakdown" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="IDE & Languages" description="Editor and programming language usage breakdown" />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const totalIDEs = data.ideDistribution.length;
  const totalLanguages = data.languageDistribution.length;
  const topIDE = data.ideDistribution.length > 0 ? data.ideDistribution[0].name : "N/A";
  const topLanguage = data.languageDistribution.length > 0 ? data.languageDistribution[0].name : "N/A";

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const trendRef = useRef<HTMLDivElement>(null);

  // Donut data for IDE distribution by interactions
  const ideDonutData = data.ideDistribution.map((ide) => ({
    name: ide.name,
    value: ide.interactions,
  }));

  // Language bar chart — top 15 by LoC added
  const langBarData = data.languageDistribution.slice(0, 15);

  return (
    <div>
      <PageHeader
        title="IDE & Languages"
        description="Editor and programming language usage breakdown"
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef, trendRef],
            title: "IDE & Languages",
            filename: `ide-languages-report-${days}d`,
            metadata: {
              reportName: "IDE & Languages",
              dateRange: `Last ${days} days`,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="IDEs Used"
          value={totalIDEs}
          icon={<Monitor className="h-4 w-4" />}
          subtitle={`Top: ${topIDE}`}
        />
        <MetricCard
          title="Languages Used"
          value={totalLanguages}
          icon={<Languages className="h-4 w-4" />}
          subtitle={`Top: ${topLanguage}`}
        />
        <MetricCard
          title="Top IDE LoC"
          value={data.ideDistribution.length > 0 ? data.ideDistribution[0].locAdded : 0}
          icon={<Code2 className="h-4 w-4" />}
          subtitle={topIDE}
        />
        <MetricCard
          title="Top Lang LoC"
          value={data.languageDistribution.length > 0 ? data.languageDistribution[0].locAdded : 0}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle={topLanguage}
        />
      </div>

      <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
        {/* IDE Donut Chart */}
        <Card>
          <CardHeader>
            <CardTitle>IDE Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {ideDonutData.length === 0 ? (
              <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
                No IDE data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={350}>
                <PieChart>
                  <Pie
                    data={ideDonutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={80}
                    outerRadius={130}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, percent }) =>
                      `${name} (${(percent * 100).toFixed(0)}%)`
                    }
                  >
                    {ideDonutData.map((_, idx) => (
                      <Cell
                        key={`cell-${idx}`}
                        fill={DONUT_COLORS[idx % DONUT_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => value.toLocaleString()} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Language Bar Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Top Languages by LoC Added</CardTitle>
          </CardHeader>
          <CardContent>
            {langBarData.length === 0 ? (
              <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
                No language data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={350}>
                <BarChart
                  data={langBarData}
                  layout="vertical"
                  margin={{ top: 5, right: 20, left: 80, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 12 }}
                    stroke="#94a3b8"
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
                    }
                  />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tick={{ fontSize: 11 }}
                    stroke="#94a3b8"
                    width={75}
                  />
                  <Tooltip formatter={(value: number) => value.toLocaleString()} />
                  <Bar dataKey="locAdded" name="LoC Added" fill={CHART_COLORS.locAdded} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* IDE Trend Chart */}
      <Card ref={trendRef}>
        <CardHeader>
          <CardTitle>IDE Usage Trend</CardTitle>
        </CardHeader>
        <CardContent>
          {data.ideTrend.length === 0 ? (
            <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              No IDE trend data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={data.ideTrend} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="day"
                  tickFormatter={formatDate}
                  tick={{ fontSize: 12 }}
                  stroke="#94a3b8"
                />
                <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" />
                <Tooltip labelFormatter={(label) => `Date: ${label}`} />
                <Legend />
                {data.allIdes.slice(0, 8).map((ide, idx) => (
                  <Line
                    key={ide}
                    type="monotone"
                    dataKey={ide}
                    name={ide}
                    stroke={TREND_COLORS[idx % TREND_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
