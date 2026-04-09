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

interface AgentAdoptionChartProps {
  data: { day: string; rate: number; monthlyActiveAgent: number; monthlyActiveTotal: number }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function AgentAdoptionChart({ data }: AgentAdoptionChartProps) {
  if (!data.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent Adoption Rate</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No agent adoption data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Adoption Rate</CardTitle>
      </CardHeader>
      <CardContent>
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
              yAxisId="left"
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
            />
            <Tooltip
              labelFormatter={(label) => `Date: ${label}`}
              formatter={(value: number, name: string) => {
                if (name === "Adoption Rate") return [`${value.toFixed(1)}%`, name];
                return [value.toLocaleString(), name];
              }}
            />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="rate"
              name="Adoption Rate"
              stroke={CHART_COLORS.agent}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="monthlyActiveAgent"
              name="Agent Users"
              stroke={CHART_COLORS.success}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              activeDot={{ r: 4 }}
              yAxisId="right"
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
