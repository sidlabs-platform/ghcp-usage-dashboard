"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { TokenDailyTrendPoint } from "@/lib/types/billing";

interface TokenTrendChartProps {
  data: TokenDailyTrendPoint[];
}

const fmtTokens = (v: number) =>
  v >= 1_000_000_000
    ? `${(v / 1_000_000_000).toFixed(1)}B`
    : v >= 1_000_000
      ? `${(v / 1_000_000).toFixed(1)}M`
      : v >= 1_000
        ? `${(v / 1_000).toFixed(1)}K`
        : String(v);

/**
 * Stacked daily token volume by class, with total credits overlaid on a second
 * axis so credit spikes can be read against the token mix that produced them.
 */
export function TokenTrendChart({ data }: TokenTrendChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No token trend data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
        <YAxis
          yAxisId="left"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          tickFormatter={fmtTokens}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          stroke="hsl(var(--muted-foreground))"
          fontSize={12}
          tickFormatter={fmtTokens}
        />
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
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="cache_read_tokens"
          name="Cache read"
          stackId="tokens"
          stroke="#14b8a6"
          fill="#14b8a6"
          fillOpacity={0.5}
        />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="cache_write_tokens"
          name="Cache write"
          stackId="tokens"
          stroke="#0ea5e9"
          fill="#0ea5e9"
          fillOpacity={0.5}
        />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="input_tokens"
          name="Input"
          stackId="tokens"
          stroke="#8b5cf6"
          fill="#8b5cf6"
          fillOpacity={0.5}
        />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="output_tokens"
          name="Output"
          stackId="tokens"
          stroke="#f59e0b"
          fill="#f59e0b"
          fillOpacity={0.5}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="total_credits"
          name="AI credits"
          stroke="#ef4444"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
