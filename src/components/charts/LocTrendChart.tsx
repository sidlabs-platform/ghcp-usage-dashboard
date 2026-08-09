"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface LocTrendChartProps {
  data: {
    day: string;
    completionSuggested: number;
    completionAccepted: number;
    agentAdded: number;
    agentDeleted: number;
    appAdded?: number;
    appDeleted?: number;
  }[];
}

export function LocTrendChart({ data }: LocTrendChartProps) {
  const hasAppData = data.some(
    (point) => point.appAdded !== undefined || point.appDeleted !== undefined,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lines of Code by Surface</CardTitle>
        <CardDescription>Code completions (suggested/accepted), agent-written code, and Copilot App code shown separately</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 12 }}
                tickFormatter={(v: string) => v.slice(5)}
                className="text-[hsl(var(--muted-foreground))]"
              />
              <YAxis tick={{ fontSize: 12 }} className="text-[hsl(var(--muted-foreground))]" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  borderColor: "hsl(var(--border))",
                  borderRadius: 8,
                }}
                labelFormatter={(label: string) => `Date: ${label}`}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="completionSuggested"
                name="Completion Suggested"
                stroke={CHART_COLORS.locSuggested}
                fill={CHART_COLORS.locSuggested}
                fillOpacity={0.1}
              />
              <Area
                type="monotone"
                dataKey="completionAccepted"
                name="Completion Accepted"
                stroke={CHART_COLORS.locAccepted}
                fill={CHART_COLORS.locAccepted}
                fillOpacity={0.15}
              />
              <Area
                type="monotone"
                dataKey="agentAdded"
                name="Agent Added"
                stroke={CHART_COLORS.agent}
                fill={CHART_COLORS.agent}
                fillOpacity={0.15}
              />
              <Area
                type="monotone"
                dataKey="agentDeleted"
                name="Agent Deleted"
                stroke={CHART_COLORS.danger}
                fill={CHART_COLORS.danger}
                fillOpacity={0.1}
              />
              {hasAppData && (
                <>
                  <Area
                    type="monotone"
                    dataKey="appAdded"
                    name="App Added"
                    stroke={CHART_COLORS.copilotApp}
                    fill={CHART_COLORS.copilotApp}
                    fillOpacity={0.15}
                  />
                  {/* Related-but-distinct shade (orange-500/orange-800) for the App "Deleted"
                      series, so it reads as part of the same App surface family as
                      CHART_COLORS.copilotApp above without being a washed-out duplicate;
                      paired with strokeDasharray to further differentiate it at a glance.
                      See CHART_COLORS.copilotAppDeleted in constants.ts for the full rationale. */}
                  <Area
                    type="monotone"
                    dataKey="appDeleted"
                    name="App Deleted"
                    stroke={CHART_COLORS.copilotAppDeleted}
                    fill={CHART_COLORS.copilotAppDeleted}
                    strokeDasharray="5 5"
                    fillOpacity={0.1}
                  />
                </>
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
