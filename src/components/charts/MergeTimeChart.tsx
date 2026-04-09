"use client";

import {
  LineChart,
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

interface MergeTimeChartProps {
  data: {
    day: string;
    humanMinutes: number | null;
    copilotMinutes: number | null;
  }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

export function MergeTimeChart({ data }: MergeTimeChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Median Time to Merge</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No merge time data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
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
                tickFormatter={(v: number) => formatMinutes(v)}
              />
              <Tooltip
                labelFormatter={(label) => `Date: ${label}`}
                formatter={(value: number, name: string) => [formatMinutes(value), name]}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="humanMinutes"
                name="All PRs"
                stroke={CHART_COLORS.human}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="copilotMinutes"
                name="Copilot-authored PRs"
                stroke={CHART_COLORS.copilot}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
