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
import { FEATURE_LABELS } from "@/lib/constants";

interface FeatureBreakdownChartProps {
  data: {
    feature: string;
    locAdded: number;
    interactions: number;
    acceptances: number;
  }[];
}

export function FeatureBreakdownChart({ data }: FeatureBreakdownChartProps) {
  const labeled = data.map((d) => ({
    ...d,
    label: FEATURE_LABELS[d.feature] ?? d.feature,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Feature Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={labeled} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 12 }}
                className="text-[hsl(var(--muted-foreground))]"
              />
              <YAxis tick={{ fontSize: 12 }} className="text-[hsl(var(--muted-foreground))]" />
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
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="interactions"
                name="Generations"
                fill={CHART_COLORS.primary}
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="acceptances"
                name="Acceptances"
                fill={CHART_COLORS.locAccepted}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
