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
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";
import { ChartTooltip } from "@/components/charts/ChartTooltip";

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

function acceptanceValueFormatter(value: number, name: string): string {
  if (name === "Rate") return `${value.toFixed(1)}%`;
  return value.toLocaleString();
}

export function AcceptanceRateChart({ data }: AcceptanceRateChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Code Acceptance Rate</CardTitle>
        <CardDescription>Completion-only LoC suggested vs accepted, with acceptance rate</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="grad-suggested" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.locSuggested} stopOpacity={0.2} />
                <stop offset="100%" stopColor={CHART_COLORS.locSuggested} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="grad-accepted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.locAccepted} stopOpacity={0.25} />
                <stop offset="100%" stopColor={CHART_COLORS.locAccepted} stopOpacity={0} />
              </linearGradient>
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
              yAxisId="loc"
              tick={{ fontSize: 12 }}
              stroke="#94a3b8"
              tickLine={false}
              axisLine={false}
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
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              content={
                <ChartTooltip
                  labelFormatter={(label) => `Date: ${label}`}
                  valueFormatter={acceptanceValueFormatter}
                />
              }
            />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            />
            <Area
              yAxisId="loc"
              type="monotone"
              dataKey="suggested"
              name="Suggested LoC"
              fill="url(#grad-suggested)"
              stroke={CHART_COLORS.locSuggested}
              strokeWidth={2}
            />
            <Area
              yAxisId="loc"
              type="monotone"
              dataKey="accepted"
              name="Accepted LoC"
              fill="url(#grad-accepted)"
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
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
