"use client";

import {
  AreaChart,
  Area,
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

interface FeatureUsageStackedChartProps {
  data: {
    day: string;
    completions: number;
    chat: number;
    agent: number;
    cli: number;
  }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const AREAS = [
  { key: "completions", name: "Completions", color: CHART_COLORS.completions },
  { key: "chat", name: "Chat", color: CHART_COLORS.chat },
  { key: "agent", name: "Agent", color: CHART_COLORS.agent },
  { key: "cli", name: "CLI", color: CHART_COLORS.cli },
] as const;

export function FeatureUsageStackedChart({ data }: FeatureUsageStackedChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Feature Usage Over Time</CardTitle>
        <CardDescription>Stacked daily activity across Copilot features</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <AreaChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <defs>
              {AREAS.map((area) => (
                <linearGradient key={area.key} id={`grad-feature-${area.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={area.color} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={area.color} stopOpacity={0.08} />
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
              tickFormatter={(v: number) =>
                v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
              }
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
            {AREAS.map((area) => (
              <Area
                key={area.key}
                type="monotone"
                dataKey={area.key}
                name={area.name}
                stackId="1"
                fill={`url(#grad-feature-${area.key})`}
                stroke={area.color}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
