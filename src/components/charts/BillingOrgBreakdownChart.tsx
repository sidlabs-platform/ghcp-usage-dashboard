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

interface BillingOrgBreakdownChartProps {
  data: { organization: string; total_net: number }[];
}

const fmtCurrency = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(2)}`;

export function BillingOrgBreakdownChart({ data }: BillingOrgBreakdownChartProps) {
  if (!data || data.length === 0)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No data available
      </div>
    );

  const sorted = useMemo(
    () => [...data].sort((a, b) => b.total_net - a.total_net),
    [data],
  );

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={sorted} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="organization"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          angle={-30}
          textAnchor="end"
          height={60}
        />
        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickFormatter={fmtCurrency} />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
          }}
          formatter={(value: number) => [fmtCurrency(value), "Cost"]}
        />
        <Legend />
        <Bar
          dataKey="total_net"
          name="Cost"
          fill="hsl(var(--primary))"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
