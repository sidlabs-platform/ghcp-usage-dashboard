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
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";
import { ChartTooltip } from "@/components/charts/ChartTooltip";

interface ActiveUsersTrendChartProps {
  data: { day: string; daily: number; weekly: number; monthly: number }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const LINES = [
  { key: "daily", name: "Daily", color: CHART_COLORS.primary },
  { key: "weekly", name: "Weekly", color: CHART_COLORS.secondary },
  { key: "monthly", name: "Monthly", color: CHART_COLORS.agent },
] as const;

export function ActiveUsersTrendChart({ data }: ActiveUsersTrendChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active Users Trend</CardTitle>
        <CardDescription>Daily, weekly (7d), and monthly (30d) rolling windows</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <defs>
              {LINES.map((l) => (
                <linearGradient key={l.key} id={`grad-${l.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={l.color} stopOpacity={0.08} />
                  <stop offset="100%" stopColor={l.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#94a3b820" vertical={false} />
            <XAxis
              dataKey="day"
              tickFormatter={formatDate}
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickLine={false}
              axisLine={{ stroke: "#94a3b830" }}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              content={
                <ChartTooltip
                  labelFormatter={(label) => `Date: ${label}`}
                  valueFormatter={(v) => v.toLocaleString()}
                />
              }
            />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            />
            {LINES.map((l) => (
              <Area
                key={`area-${l.key}`}
                type="monotone"
                dataKey={l.key}
                fill={`url(#grad-${l.key})`}
                stroke="none"
              />
            ))}
            {LINES.map((l) => (
              <Line
                key={l.key}
                type="monotone"
                dataKey={l.key}
                name={l.name}
                stroke={l.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
