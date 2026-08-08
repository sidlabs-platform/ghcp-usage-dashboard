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

export interface AdoptionVolumeTooltipPayloadEntry {
  name: string;
  value: number;
  color: string;
  dataKey: string;
}

export interface AdoptionVolumeTooltipProps {
  active?: boolean;
  payload?: AdoptionVolumeTooltipPayloadEntry[];
  label?: string;
  data: CopilotAppAdoptionTrendPoint[];
}

/**
 * Custom tooltip for the adoption/volume chart. Recharts' default tooltip
 * `payload` only ever contains the plotted series (active users, sessions,
 * requests) — prompts is intentionally not plotted (a fourth overlapping
 * line at this density reads as noise rather than signal), so it would
 * never surface via the default tooltip content. This looks the hovered
 * day up in the original `data` array so prompts still shows for the
 * hovered day without adding a plotted series.
 */
export function AdoptionVolumeTooltip({ active, payload, label, data }: AdoptionVolumeTooltipProps) {
  if (!active || !payload?.length || label == null) return null;

  const point = data.find((d) => d.day === label);

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl p-3">
      <p className="text-xs text-[hsl(var(--muted-foreground))] mb-2 font-medium">
        Date: {formatDate(label)}
      </p>
      <div className="flex flex-col gap-1.5">
        {payload.map((entry, i) => (
          <div key={`${entry.dataKey}-${i}`} className="flex items-center gap-2 text-sm">
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-[hsl(var(--muted-foreground))]">{entry.name}</span>
            <span className="ml-auto font-semibold text-[hsl(var(--card-foreground))]">
              {entry.value.toLocaleString()}
            </span>
          </div>
        ))}
        {point && (
          <div className="flex items-center gap-2 text-sm">
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: CHART_COLORS.agent }}
            />
            <span className="text-[hsl(var(--muted-foreground))]">Prompts</span>
            <span className="ml-auto font-semibold text-[hsl(var(--card-foreground))]">
              {point.prompts.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Daily Copilot App adoption and usage volume — active users as an area
 * (the adoption signal) with sessions/requests as lines (the volume
 * signal). Prompts are intentionally not a plotted series per the approved
 * design (a fourth overlapping line at this density reads as noise rather
 * than signal), but a custom tooltip surfaces the prompt count for the
 * hovered day alongside the plotted metrics.
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
              <Tooltip content={<AdoptionVolumeTooltip data={data} />} />
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
