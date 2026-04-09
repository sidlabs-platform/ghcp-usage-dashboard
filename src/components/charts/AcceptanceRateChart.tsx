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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface AcceptanceRateChartProps {
  data: {
    day: string;
    suggested: number;
    accepted: number;
    rate: number;
  }[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function AcceptanceRateChart({ data }: AcceptanceRateChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Code Acceptance Rate</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="day"
              tickFormatter={formatDate}
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
            />
            <YAxis
              yAxisId="loc"
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickFormatter={(v: number) =>
                v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
              }
            />
            <YAxis
              yAxisId="rate"
              orientation="right"
              domain={[0, 100]}
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              labelFormatter={(label) => `Date: ${label}`}
              formatter={(value: number, name: string) => {
                if (name === "Rate")
                  return [`${value.toFixed(1)}%`, name];
                return [value.toLocaleString(), name];
              }}
            />
            <Legend />
            <Area
              yAxisId="loc"
              type="monotone"
              dataKey="suggested"
              name="Suggested LoC"
              fill={CHART_COLORS.locSuggested}
              fillOpacity={0.15}
              stroke={CHART_COLORS.locSuggested}
              strokeWidth={2}
            />
            <Area
              yAxisId="loc"
              type="monotone"
              dataKey="accepted"
              name="Accepted LoC"
              fill={CHART_COLORS.locAccepted}
              fillOpacity={0.25}
              stroke={CHART_COLORS.locAccepted}
              strokeWidth={2}
            />
            <Line
              yAxisId="rate"
              type="monotone"
              dataKey="rate"
              name="Rate"
              stroke={CHART_COLORS.success}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
