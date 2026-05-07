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

interface UserRow {
  username: string;
  organization: string;
  total_net: number;
}

interface BillingUserBreakdownChartProps {
  data: UserRow[];
  limit?: number;
}

const fmtCurrency = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(2)}`;

export function BillingUserBreakdownChart({ data, limit = 15 }: BillingUserBreakdownChartProps) {
  const sorted = useMemo(
    () => [...(data || [])].sort((a, b) => b.total_net - a.total_net).slice(0, limit),
    [data, limit],
  );

  if (!data || data.length === 0)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No user data available
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
          formatter={(value: number) => [fmtCurrency(value), "Cost"]}
          labelFormatter={(label: string) => {
            const row = sorted.find((r) => r.username === label);
            return row ? `${label} (${row.organization})` : label;
          }}
        />
        <Legend />
        <Bar
          dataKey="total_net"
          name="Net Cost"
          fill="#f59e0b"
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
