"use client";

import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface CLITokenChartProps {
  data: { day: string; promptTokens: number; outputTokens: number; avgPerRequest: number }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTokens(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
}

export function CLITokenChart({ data }: CLITokenChartProps) {
  if (!data.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>CLI Token Consumption</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No CLI token data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>CLI Token Consumption</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="day"
              tickFormatter={formatDate}
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickFormatter={formatTokens}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickFormatter={formatTokens}
            />
            <Tooltip
              labelFormatter={(label) => `Date: ${label}`}
              formatter={(value: number, name: string) => [value.toLocaleString(), name]}
            />
            <Legend />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="promptTokens"
              name="Prompt Tokens"
              stackId="1"
              fill={CHART_COLORS.primary}
              fillOpacity={0.3}
              stroke={CHART_COLORS.primary}
              strokeWidth={1.5}
            />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="outputTokens"
              name="Output Tokens"
              stackId="1"
              fill={CHART_COLORS.secondary}
              fillOpacity={0.3}
              stroke={CHART_COLORS.secondary}
              strokeWidth={1.5}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="avgPerRequest"
              name="Avg Tokens/Request"
              stroke={CHART_COLORS.warning}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
