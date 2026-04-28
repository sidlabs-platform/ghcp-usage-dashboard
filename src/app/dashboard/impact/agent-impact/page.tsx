"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Users, Bot, Code, TrendingUp, FileCode } from "lucide-react";
import { formatNumber } from "@/lib/utils";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

interface AgentImpactDaily {
  day: string;
  agentUsers: number;
  codingAgentUsers: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  totalLocAdded: number;
  totalLocDeleted: number;
}

interface AgentImpactKpis {
  totalAgentUsers: number;
  totalCodingAgentUsers: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  totalLocAdded: number;
  totalLocDeleted: number;
  agentLocPercent: number;
}

interface ImpactData {
  days: number;
  start: string;
  end: string;
  agentImpact?: {
    daily: AgentImpactDaily[];
    kpis: AgentImpactKpis;
  };
}

const PAGE_TITLE = "Agent Impact";
const PAGE_DESCRIPTION =
  "Copilot agent usage, coding agent adoption, and lines-of-code contribution";

export default function AgentImpactPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<ImpactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    const scopeParams = buildScopeParams();
    const params = new URLSearchParams({ days: String(days) });
    scopeParams.forEach((v, k) => params.set(k, v));

    fetch(`/api/metrics/impact?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, buildScopeParams]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 mb-8">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  if (!data.agentImpact) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="flex h-64 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          Agent impact data is not available
        </div>
      </div>
    );
  }

  const { kpis, daily } = data.agentImpact;

  return (
    <div>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: PAGE_TITLE,
            filename: `agent-impact-report-${days}d`,
            metadata: {
              reportName: PAGE_TITLE,
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 mb-8"
      >
        <MetricCard
          title="Agent Users"
          value={kpis.totalAgentUsers}
          icon={<Users className="h-4 w-4" />}
        />
        <MetricCard
          title="Coding Agent Users"
          value={kpis.totalCodingAgentUsers}
          icon={<Bot className="h-4 w-4" />}
        />
        <MetricCard
          title="Agent LoC Added"
          value={kpis.agentLocAdded}
          icon={<Code className="h-4 w-4" />}
        />
        <MetricCard
          title="Agent LoC %"
          value={kpis.agentLocPercent}
          format="percent"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <MetricCard
          title="Total LoC Added"
          value={kpis.totalLocAdded}
          icon={<FileCode className="h-4 w-4" />}
        />
      </div>

      <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Agent LoC vs Total LoC</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={380}>
              <AreaChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  label={{
                    value: "Lines of Code",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 12 },
                  }}
                />
                <Tooltip
                  formatter={(value: number) => [
                    formatNumber(value),
                    undefined,
                  ]}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="totalLocAdded"
                  name="Total LoC"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.1}
                />
                <Area
                  type="monotone"
                  dataKey="agentLocAdded"
                  name="Agent LoC"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.3}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent Users vs Coding Agent Users</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={380}>
              <BarChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  label={{
                    value: "Users",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 12 },
                  }}
                />
                <Tooltip />
                <Legend />
                <Bar
                  dataKey="agentUsers"
                  name="Agent Users"
                  fill="#8b5cf6"
                />
                <Bar
                  dataKey="codingAgentUsers"
                  name="Coding Agent Users"
                  fill="#f59e0b"
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
