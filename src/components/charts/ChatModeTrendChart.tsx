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

interface ChatModeTrendChartProps {
  data: { day: string; ask: number; edit: number; plan: number; agent: number; custom: number }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const MODES = [
  { key: "ask", name: "Ask", color: CHART_COLORS.ask },
  { key: "edit", name: "Edit", color: CHART_COLORS.edit },
  { key: "plan", name: "Plan", color: CHART_COLORS.plan },
  { key: "agent", name: "Agent", color: CHART_COLORS.agent },
  { key: "custom", name: "Custom", color: CHART_COLORS.custom },
] as const;

export function ChatModeTrendChart({ data }: ChatModeTrendChartProps) {
  if (!data.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chat Mode Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No chat mode data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Mode Trend</CardTitle>
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
              tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
            />
            <Tooltip
              labelFormatter={(label) => `Date: ${label}`}
              formatter={(value: number, name: string) => [value.toLocaleString(), name]}
            />
            <Legend />
            {MODES.map((mode) => (
              <Area
                key={mode.key}
                type="monotone"
                dataKey={mode.key}
                name={mode.name}
                stackId="1"
                fill={mode.color}
                fillOpacity={0.4}
                stroke={mode.color}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
