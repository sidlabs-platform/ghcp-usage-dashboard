"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface IdeBreakdownChartProps {
  data: { ide: string; interactions: number; locAdded: number }[];
  title?: string;
}

export function IdeBreakdownChart({
  data,
  title = "IDE / Editor Usage",
}: Readonly<IdeBreakdownChartProps>) {
  // Dynamic height: at least 240px, +32px per IDE row
  const chartHeight = Math.max(240, data.length * 32 + 40);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>User-initiated interactions by editor</CardDescription>
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
                  name === "interactions" ? "Interactions" : "LoC Added",
                ]}
              />
              <Bar
                dataKey="interactions"
                name="interactions"
                fill={CHART_COLORS.vscode}
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
