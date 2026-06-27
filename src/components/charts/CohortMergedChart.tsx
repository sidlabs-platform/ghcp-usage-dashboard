"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

const PHASE_COLORS: Record<number, string> = {
  0: "#94a3b8", // slate-400
  1: "#3b82f6", // blue-500
  2: "#8b5cf6", // violet-500
  3: "#6366f1", // indigo-500
};

export interface CohortMergedData {
  phase: number;
  label: string;
  count: number;
  percentage: number;
}

interface CohortMergedChartProps {
  data: CohortMergedData[];
}

/**
 * Absolute pull requests merged by AI adoption phase — surfaces the delivery
 * impact (shipped changes) of each cohort, not just per-user averages.
 */
export function CohortMergedChart({ data }: CohortMergedChartProps) {
  if (!data.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>PRs Merged by Adoption Phase</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No merged-PR data available for these cohorts
          </div>
        </CardContent>
      </Card>
    );
  }

  if (data.every((d) => d.count === 0)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>PRs Merged by Adoption Phase</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[350px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No pull requests were merged by these cohorts in this window.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>PRs Merged by Adoption Phase</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 5, right: 48, left: 0, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 12 }} allowDecimals={false} />
            <YAxis
              dataKey="label"
              type="category"
              width={120}
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              formatter={(value: number) => [`${value.toLocaleString()} PRs`, "Merged"]}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {data.map((entry) => (
                <Cell
                  key={`cell-${entry.phase}`}
                  fill={PHASE_COLORS[entry.phase] ?? "#94a3b8"}
                />
              ))}
              <LabelList
                dataKey="percentage"
                position="right"
                formatter={(v: number) => `${v.toFixed(1)}%`}
                style={{ fontSize: 12, fill: "hsl(var(--foreground))" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
