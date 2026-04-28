"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Clock, Timer, Users } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

interface TimeToValueDistribution {
  daysBucket: string;
  userCount: number;
}

interface ImpactData {
  days: number;
  start: string;
  end: string;
  timeToValue?: {
    distribution: TimeToValueDistribution[];
    averageDays: number;
    medianDays: number;
    totalUsers: number;
  };
}

export default function TimeToValuePage() {
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
          title="Time to Value"
          description="How quickly users reach meaningful Copilot usage"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
          {Array.from({ length: 3 }).map((_, i) => (
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
          title="Time to Value"
          description="How quickly users reach meaningful Copilot usage"
        />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  if (!data.timeToValue) {
    return (
      <div>
        <PageHeader
          title="Time to Value"
          description="How quickly users reach meaningful Copilot usage"
        />
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-[hsl(var(--muted-foreground))]">
          <Clock className="h-10 w-10 opacity-40" />
          <p className="font-medium">
            Time to value data is not available
          </p>
        </div>
      </div>
    );
  }

  const { distribution, averageDays, medianDays, totalUsers } =
    data.timeToValue;

  return (
    <div>
      <PageHeader
        title="Time to Value"
        description="How quickly users reach meaningful Copilot usage"
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: "Time to Value",
            filename: `time-to-value-${days}d`,
            metadata: {
              reportName: "Time to Value",
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 mb-8"
      >
        <MetricCard
          title="Average Days"
          value={averageDays.toFixed(1)}
          format="raw"
          icon={<Clock className="h-4 w-4" />}
          subtitle="To first meaningful use"
        />
        <MetricCard
          title="Median Days"
          value={medianDays.toFixed(1)}
          format="raw"
          icon={<Timer className="h-4 w-4" />}
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
            <CardTitle>Time to Value Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={distribution}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="daysBucket" />
                <YAxis />
                <Tooltip />
                <Bar
                  dataKey="userCount"
                  name="Users"
                  fill="#3b82f6"
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
