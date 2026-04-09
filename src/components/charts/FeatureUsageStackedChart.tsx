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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

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
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <AreaChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="day"
              tickFormatter={formatDate}
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
            />
            <YAxis
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickFormatter={(v: number) =>
                v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
              }
            />
            <Tooltip
              labelFormatter={(label) => `Date: ${label}`}
              formatter={(value: number, name: string) => [
                value.toLocaleString(),
                name,
              ]}
            />
            <Legend />
            {AREAS.map((area) => (
              <Area
                key={area.key}
                type="monotone"
                dataKey={area.key}
                name={area.name}
                stackId="1"
                fill={area.color}
                fillOpacity={0.4}
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
