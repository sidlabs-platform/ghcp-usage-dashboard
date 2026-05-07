"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";

interface QuotaRow {
  username: string;
  within_quota: number;
  over_quota: number;
  quota_limit: number;
}

interface PremiumQuotaChartProps {
  data: QuotaRow[];
}

export function PremiumQuotaChart({ data }: PremiumQuotaChartProps) {
  const sorted = useMemo(
    () =>
      [...(data || [])]
        .sort((a, b) => b.within_quota + b.over_quota - (a.within_quota + a.over_quota))
        .slice(0, 15),
    [data],
  );

  if (!data || data.length === 0)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No data available
      </div>
    );

  // Use the first row's quota_limit as the reference line value (assumes uniform limit)
  const quotaLimit = sorted.length > 0 ? sorted[0].quota_limit : 0;

  const chartHeight = Math.max(300, sorted.length * 32 + 40);

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart
        data={sorted}
        layout="vertical"
        margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          type="number"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
        />
        <YAxis
          type="category"
          dataKey="username"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          width={120}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
          }}
          formatter={(value: number, name: string) => [value.toLocaleString(), name]}
        />
        <Legend />
        {quotaLimit > 0 && (
          <ReferenceLine
            x={quotaLimit}
            stroke="hsl(var(--muted-foreground))"
            strokeDasharray="4 4"
            label={{ value: "Quota", position: "top", fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          />
        )}
        <Bar
          dataKey="within_quota"
          name="Within Quota"
          stackId="usage"
          fill="#10b981"
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="over_quota"
          name="Over Quota"
          stackId="usage"
          fill="#ef4444"
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
