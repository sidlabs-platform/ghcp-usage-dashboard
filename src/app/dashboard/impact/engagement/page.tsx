"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Layers, Users } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";

interface EngagementDistribution {
  featureCount: number;
  userCount: number;
}

interface ImpactData {
  days: number;
  start: string;
  end: string;
  engagementDepth?: {
    distribution: EngagementDistribution[];
    averageDepth: number;
    totalUsers: number;
  };
}

const BAR_COLORS = ["#ef4444", "#f59e0b", "#eab308", "#10b981", "#3b82f6"];

export default function EngagementDepthPage() {
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
        <PageHeader
          title="Engagement Depth"
          description="Feature adoption breadth across users"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
          {Array.from({ length: 2 }).map((_, i) => (
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
        <PageHeader
          title="Engagement Depth"
          description="Feature adoption breadth across users"
        />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  if (!data.engagementDepth) {
    return (
      <div>
        <PageHeader
          title="Engagement Depth"
          description="Feature adoption breadth across users"
        />
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-[hsl(var(--muted-foreground))]">
          <Layers className="h-10 w-10 opacity-40" />
          <p className="font-medium">
            Engagement depth data is not available
          </p>
        </div>
      </div>
    );
  }

  const { distribution, averageDepth, totalUsers } = data.engagementDepth;

  const chartData = distribution.map((d) => ({
    ...d,
    label:
      d.featureCount === 1
        ? "1 Feature"
        : `${d.featureCount} Features`,
  }));

  return (
    <div>
      <PageHeader
        title="Engagement Depth"
        description="Feature adoption breadth across users"
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: "Engagement Depth",
            filename: `engagement-depth-${days}d`,
            metadata: {
              reportName: "Engagement Depth",
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-2 mb-8"
      >
        <MetricCard
          title="Average Depth"
          value={averageDepth.toFixed(1)}
          format="raw"
          icon={<Layers className="h-4 w-4" />}
          subtitle="Out of 5 features"
        />
        <MetricCard
          title="Total Users"
          value={totalUsers}
          icon={<Users className="h-4 w-4" />}
        />
      </div>

      <div ref={chartsRef}>
        <Card>
          <CardHeader>
            <CardTitle>Feature Adoption Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="userCount" name="Users">
                  {chartData.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={BAR_COLORS[index % BAR_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
