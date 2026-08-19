"use client";

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
import type { TokenDailyTrendPoint } from "@/lib/types/billing";

interface TokenPoolSplitChartProps {
  data: TokenDailyTrendPoint[];
}

const fmt = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}K` : v.toFixed(0);

/**
 * Daily AI credits split into allowance-covered ("pool") and billable
 * ("additional") portions, derived from `discount_amount` / `net_amount`.
 */
export function TokenPoolSplitChart({ data }: TokenPoolSplitChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No credit data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickFormatter={fmt} />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
          }}
          formatter={(value: number, name: string) => [
            Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }),
            name,
          ]}
        />
        <Legend />
        <Bar dataKey="pool_credits" name="Included allowance" stackId="credits" fill="#10b981" radius={[0, 0, 0, 0]} />
        <Bar dataKey="paid_credits" name="Additional (billable)" stackId="credits" fill="#f59e0b" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
