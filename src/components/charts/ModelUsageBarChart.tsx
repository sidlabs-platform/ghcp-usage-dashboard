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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface ModelUsageBarChartProps {
  data: { model: string; interactions: number }[];
}

export function ModelUsageBarChart({ data }: ModelUsageBarChartProps) {
  const chartHeight = Math.max(300, data.length * 32 + 40);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interactions by Model</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No model usage data available
          </div>
        ) : (
          <div style={{ height: chartHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                layout="vertical"
                margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 12 }}
                  className="text-[hsl(var(--muted-foreground))]"
                  tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)}
                />
                <YAxis
                  type="category"
                  dataKey="model"
                  tick={{ fontSize: 11 }}
                  width={160}
                  className="text-[hsl(var(--muted-foreground))]"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    borderColor: "hsl(var(--border))",
                    borderRadius: 8,
                  }}
                  formatter={(value: number) => [value.toLocaleString(), "Interactions"]}
                />
                <Bar
                  dataKey="interactions"
                  name="Interactions"
                  fill={CHART_COLORS.primary}
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
