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
import type { CopilotAppAdoptionTrendPoint } from "@/lib/types/metrics";

interface CopilotAppAdoptionVolumeChartProps {
  data: CopilotAppAdoptionTrendPoint[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Daily Copilot App adoption and usage volume — active users as an area
 * (the adoption signal) with sessions/requests as lines (the volume
 * signal). Prompts are intentionally tooltip-only (not a plotted series)
 * per the approved design — a fourth overlapping line at this density
 * reads as noise rather than signal.
 */
export function CopilotAppAdoptionVolumeChart({ data }: CopilotAppAdoptionVolumeChartProps) {
  if (!data.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Adoption &amp; Volume</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No Copilot App adoption data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Adoption &amp; Volume</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          role="img"
          aria-label="Daily Copilot App active users, sessions, and requests"
        >
          <ResponsiveContainer width="100%" height={350}>
            <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
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
              <Area
                type="monotone"
                dataKey="activeUsers"
                name="Active Users"
                fill={CHART_COLORS.copilotApp}
                fillOpacity={0.2}
                stroke={CHART_COLORS.copilotApp}
                strokeWidth={2}
              />
              <Line
                type="monotone"
                dataKey="sessions"
                name="Sessions"
                stroke={CHART_COLORS.primary}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="requests"
                name="Requests"
                stroke={CHART_COLORS.secondary}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
