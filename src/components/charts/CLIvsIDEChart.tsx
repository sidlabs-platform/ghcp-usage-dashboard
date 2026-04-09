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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface CLIvsIDEChartProps {
  data: { day: string; ideUsers: number; cliUsers: number }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function CLIvsIDEChart({ data }: CLIvsIDEChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>CLI vs IDE Users</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
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
              formatter={(value: number, name: string) => [
                value.toLocaleString(),
                name,
              ]}
            />
            <Legend />
            <Bar
              dataKey="ideUsers"
              name="IDE Users"
              fill={CHART_COLORS.primary}
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="cliUsers"
              name="CLI Users"
              fill={CHART_COLORS.cli}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
