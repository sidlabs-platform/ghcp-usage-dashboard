"use client";

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export interface SeatLifecycleTrendPointData {
  day: string;
  onboarded: number;
  offboarded: number;
  net: number;
}

interface SeatLifecycleTrendChartProps {
  data: SeatLifecycleTrendPointData[];
  /** Rendered in the empty state so the page can explain *why* it is empty. */
  emptyMessage?: string;
}

function formatDay(day: string): string {
  // 'YYYY-MM-DD' → 'MM/DD' without constructing a Date (avoids TZ shifting).
  const parts = day.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : day;
}

/**
 * Daily onboarded vs offboarded seat counts with a net-change line.
 *
 * Offboarded bars are plotted as negative values so the two directions read
 * against a shared zero baseline; the tooltip restores the absolute count.
 */
export function SeatLifecycleTrendChart({ data, emptyMessage }: SeatLifecycleTrendChartProps) {
  const hasData = data.some((d) => d.onboarded > 0 || d.offboarded > 0);

  if (!hasData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Daily Seat Changes</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[320px] items-center justify-center text-center text-sm text-[hsl(var(--muted-foreground))]">
            {emptyMessage ?? "No seat changes recorded in this window."}
          </div>
        </CardContent>
      </Card>
    );
  }

  const chartData = data.map((d) => ({ ...d, offboardedNegative: -d.offboarded }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily Seat Changes</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="day" tickFormatter={formatDay} tick={{ fontSize: 12 }} minTickGap={16} />
            <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
            <Tooltip
              formatter={(value: number, name: string) => {
                if (name === "Offboarded") return [Math.abs(value).toLocaleString(), name];
                return [value.toLocaleString(), name];
              }}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Bar dataKey="onboarded" name="Onboarded" fill="#22c55e" radius={[4, 4, 0, 0]} />
            <Bar dataKey="offboardedNegative" name="Offboarded" fill="#ef4444" radius={[0, 0, 4, 4]} />
            <Line type="monotone" dataKey="net" name="Net change" stroke="#6366f1" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
