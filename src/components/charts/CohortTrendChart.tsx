"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

const PHASE_CONFIG = [
  { key: "phase0", label: "No cohort", color: "#94a3b8" },
  { key: "phase1", label: "Code first", color: "#3b82f6" },
  { key: "phase2", label: "Agent first", color: "#8b5cf6" },
  { key: "phase3", label: "Multi-agent", color: "#6366f1" },
];

export interface CohortTrendDataPoint {
  day: string;
  phase0: number;
  phase1: number;
  phase2: number;
  phase3: number;
}

interface CohortTrendChartProps {
  data: CohortTrendDataPoint[];
  title?: string;
  /** Unit label shown in the tooltip (e.g. "users", "PRs merged"). */
  valueLabel?: string;
}

/** Parse YYYY-MM-DD without Date constructor to avoid UTC→local timezone shift */
function formatDate(dateStr: string) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}`;
}

export function CohortTrendChart({
  data,
  title = "Adoption Phase Trend",
  valueLabel,
}: CohortTrendChartProps) {
  if (!data.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No adoption cohort trend data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <AreaChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="day"
              tickFormatter={formatDate}
              tick={{ fontSize: 12 }}
              interval="preserveStartEnd"
            />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={
                valueLabel
                  ? (value: number, name: string) => [`${value} ${valueLabel}`, name]
                  : undefined
              }
              labelFormatter={(label: string) => {
                const [y, m, d] = label.split("-").map(Number);
                return new Date(y, m - 1, d).toLocaleDateString();
              }}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
            />
            <Legend />
            {PHASE_CONFIG.map((phase) => (
              <Area
                key={phase.key}
                type="monotone"
                dataKey={phase.key}
                name={phase.label}
                stackId="1"
                stroke={phase.color}
                fill={phase.color}
                fillOpacity={0.6}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
