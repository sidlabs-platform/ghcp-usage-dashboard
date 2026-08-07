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
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface IdeBreakdownChartProps {
  data: { ide: string; interactions: number; locAdded: number }[];
  title?: string;
}

const SERIES_LABELS: Record<string, string> = {
  interactions: "Interactions",
  locAdded: "LoC Added",
};

export function IdeBreakdownChart({
  data,
  title = "IDE / Editor Usage",
}: Readonly<IdeBreakdownChartProps>) {
  // Dynamic height: at least 240px, +48px per IDE row (two bars per row)
  const chartHeight = Math.max(240, data.length * 48 + 40);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>User-initiated interactions and lines added by editor</CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 5, right: 20, bottom: 5, left: 80 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
              <XAxis
                type="number"
                tick={{ fontSize: 12 }}
                className="text-[hsl(var(--muted-foreground))]"
              />
              <YAxis
                type="category"
                dataKey="ide"
                tick={{ fontSize: 12 }}
                width={75}
                className="text-[hsl(var(--muted-foreground))]"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  borderColor: "hsl(var(--border))",
                  borderRadius: 8,
                }}
                formatter={(value: number, name: string) => [
                  value.toLocaleString(),
                  SERIES_LABELS[name] ?? name,
                ]}
              />
              <Legend formatter={(name: string) => SERIES_LABELS[name] ?? name} />
              <Bar
                dataKey="interactions"
                name="interactions"
                fill={CHART_COLORS.vscode}
                radius={[0, 4, 4, 0]}
              />
              <Bar
                dataKey="locAdded"
                name="locAdded"
                fill={CHART_COLORS.locAdded}
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
