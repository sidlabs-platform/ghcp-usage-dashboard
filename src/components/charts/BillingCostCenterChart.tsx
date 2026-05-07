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

interface CostCenterRow {
  cost_center_name: string;
  total_net: number;
  record_count: number;
}

interface BillingCostCenterChartProps {
  data: CostCenterRow[];
}

const fmtCurrency = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(2)}`;

export function BillingCostCenterChart({ data }: BillingCostCenterChartProps) {
  const sorted = useMemo(
    () => [...(data || [])].sort((a, b) => b.total_net - a.total_net),
    [data],
  );

  if (!data || data.length === 0)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No cost center data available
      </div>
    );

  const chartHeight = Math.max(300, sorted.length * 36 + 40);

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
          dataKey="cost_center_name"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          width={160}
        />
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
          name="Net Cost"
          fill="#8b5cf6"
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
