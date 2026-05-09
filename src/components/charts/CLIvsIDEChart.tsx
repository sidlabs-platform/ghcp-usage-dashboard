"use client";

import {
  BarChart,
  Bar,
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

interface CLIvsIDEChartProps {
  data: { day: string; ideUsers: number; cliUsers: number }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const BARS = [
  { key: "ideUsers", name: "IDE Users", color: CHART_COLORS.primary },
  { key: "cliUsers", name: "CLI Users", color: CHART_COLORS.cli },
] as const;

export function CLIvsIDEChart({ data }: CLIvsIDEChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>CLI vs IDE Users</CardTitle>
        <CardDescription>Daily unique users by interface type</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <defs>
              {BARS.map((bar) => (
                <linearGradient key={bar.key} id={`grad-bar-${bar.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={bar.color} stopOpacity={0.9} />
                  <stop offset="100%" stopColor={bar.color} stopOpacity={0.5} />
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
            {BARS.map((bar) => (
              <Bar
                key={bar.key}
                dataKey={bar.key}
                name={bar.name}
                fill={`url(#grad-bar-${bar.key})`}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
