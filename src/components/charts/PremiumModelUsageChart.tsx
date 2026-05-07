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
} from "recharts";

interface PremiumModelUsageChartProps {
  data: { model: string; total_requests: number; total_net: number }[];
}

const fmtCurrency = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(2)}`;

const fmtCount = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(1)}K` : `${v}`;

export function PremiumModelUsageChart({ data }: PremiumModelUsageChartProps) {
  const sorted = useMemo(
    () => [...(data || [])].sort((a, b) => b.total_requests - a.total_requests),
    [data],
  );

  if (!data || data.length === 0)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No data available
      </div>
    );

  return (
    <ResponsiveContainer width="100%" height={350}>
      <BarChart data={sorted} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="model"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          angle={-30}
          textAnchor="end"
          height={70}
        />
        <YAxis
          yAxisId="left"
          stroke="#3b82f6"
          fontSize={12}
          tickFormatter={fmtCount}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          stroke="#10b981"
          fontSize={12}
          tickFormatter={fmtCurrency}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
          }}
          formatter={(value: number, name: string) => [
            name === "Requests" ? fmtCount(value) : fmtCurrency(value),
            name,
          ]}
        />
        <Legend />
        <Bar
          yAxisId="left"
          dataKey="total_requests"
          name="Requests"
          fill="#3b82f6"
          radius={[4, 4, 0, 0]}
        />
        <Bar
          yAxisId="right"
          dataKey="total_net"
          name="Cost"
          fill="#10b981"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
