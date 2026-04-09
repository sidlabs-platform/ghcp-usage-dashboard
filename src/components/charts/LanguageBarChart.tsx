"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS } from "@/lib/constants";

interface LanguageBarChartProps {
  data: { language: string; locAdded: number; locSuggested: number }[];
  title?: string;
}

export function LanguageBarChart({
  data,
  title = "LoC by Language",
}: LanguageBarChartProps) {
  // Dynamic height: at least 300px, +28px per language row
  const chartHeight = Math.max(300, data.length * 28 + 40);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
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
                dataKey="language"
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
              />
              <Legend />
              <Bar
                dataKey="locAdded"
                name="LoC Added"
                fill={CHART_COLORS.locAdded}
                radius={[0, 4, 4, 0]}
              />
              <Bar
                dataKey="locSuggested"
                name="LoC Suggested"
                fill={CHART_COLORS.locSuggested}
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
