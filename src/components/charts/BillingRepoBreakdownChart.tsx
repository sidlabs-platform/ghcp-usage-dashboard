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

interface RepoRow {
  repository: string;
  organization: string;
  total_net: number;
}

interface BillingRepoBreakdownChartProps {
  data: RepoRow[];
  limit?: number;
}

const fmtCurrency = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(2)}`;

export function BillingRepoBreakdownChart({ data, limit = 15 }: BillingRepoBreakdownChartProps) {
  const sorted = useMemo(
    () => [...(data || [])].sort((a, b) => b.total_net - a.total_net).slice(0, limit),
    [data, limit],
  );

  if (!data || data.length === 0)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No repository data available
      </div>
    );

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
          tickFormatter={fmtCurrency}
        />
        <YAxis
          type="category"
          dataKey="repository"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          width={200}
          tickFormatter={(value: string) => {
            // Truncate long repo names
            return value.length > 30 ? value.substring(0, 27) + "..." : value;
          }}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
          }}
          formatter={(value: number) => [fmtCurrency(value), "Cost"]}
          labelFormatter={(label: string) => {
            const row = sorted.find((r) => r.repository === label);
            return row ? `${row.organization}/${label}` : label;
          }}
        />
        <Legend />
        <Bar
          dataKey="total_net"
          name="Net Cost"
          fill="#06b6d4"
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
