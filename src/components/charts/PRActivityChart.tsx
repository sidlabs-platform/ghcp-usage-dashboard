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

interface PRActivityChartProps {
  data: {
    day: string;
    total_created: number;
    total_reviewed: number;
    total_merged: number;
  }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function PRActivityChart({ data }: PRActivityChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>PR Activity Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No pull request data available
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
              <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" />
              <Tooltip
                labelFormatter={(label) => `Date: ${label}`}
                formatter={(value: number, name: string) => [value.toLocaleString(), name]}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="total_created"
                name="Created"
                stroke={CHART_COLORS.primary}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="total_reviewed"
                name="Reviewed"
                stroke={CHART_COLORS.warning}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="total_merged"
                name="Merged"
                stroke={CHART_COLORS.success}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
