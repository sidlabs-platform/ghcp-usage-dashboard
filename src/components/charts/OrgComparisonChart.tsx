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

interface OrgComparisonChartProps {
  data: { name: string; activeUsers: number; totalSeats: number }[];
}

export function OrgComparisonChart({ data }: OrgComparisonChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Comparison</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(300, data.length * 50)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 5, right: 20, left: 80, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis type="number" tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              width={70}
            />
            <Tooltip
              formatter={(value: number, name: string) => [
                value.toLocaleString(),
                name,
              ]}
            />
            <Legend />
            <Bar
              dataKey="activeUsers"
              name="Active Users"
              fill={CHART_COLORS.primary}
              radius={[0, 4, 4, 0]}
            />
            <Bar
              dataKey="totalSeats"
              name="Total Seats"
              fill={CHART_COLORS.secondary}
              radius={[0, 4, 4, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
