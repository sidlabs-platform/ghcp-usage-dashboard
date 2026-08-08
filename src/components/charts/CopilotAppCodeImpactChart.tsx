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
import type { CopilotAppCodeImpactPoint } from "@/lib/types/metrics";

interface CopilotAppCodeImpactChartProps {
  data: CopilotAppCodeImpactPoint[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Daily Copilot App code impact — lines added/deleted as areas (the code
 * volume signal) with generations/acceptances as lines (the activity
 * signal). Sourced only from the `copilot_app` feature row, per
 * {@link CopilotAppCodeImpactPoint} — never mixed with completion or
 * agent-edit LoC.
 */
export function CopilotAppCodeImpactChart({ data }: CopilotAppCodeImpactChartProps) {
  if (!data.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Code Impact</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No Copilot App code impact data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Code Impact</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          role="img"
          aria-label="Daily Copilot App lines added, lines deleted, generations, and acceptances"
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
                dataKey="locAdded"
                name="LoC Added"
                fill={CHART_COLORS.copilotApp}
                fillOpacity={0.15}
                stroke={CHART_COLORS.copilotApp}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="locDeleted"
                name="LoC Deleted"
                fill={CHART_COLORS.copilotAppDeleted}
                fillOpacity={0.1}
                stroke={CHART_COLORS.copilotAppDeleted}
                strokeDasharray="5 5"
                strokeWidth={2}
              />
              <Line
                type="monotone"
                dataKey="generations"
                name="Generations"
                stroke={CHART_COLORS.primary}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="acceptances"
                name="Acceptances"
                stroke={CHART_COLORS.locAccepted}
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
