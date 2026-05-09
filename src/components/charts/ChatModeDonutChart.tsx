"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ChartTooltip } from "@/components/charts/ChartTooltip";

interface ChatModeDonutChartProps {
  data: { name: string; value: number; color: string }[];
}

interface LabelProps {
  cx: number;
  cy: number;
  midAngle: number;
  innerRadius: number;
  outerRadius: number;
  percent: number;
  name: string;
}

const RADIAN = Math.PI / 180;

function renderLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }: LabelProps) {
  if (percent < 0.03) return null;
  const radius = innerRadius + (outerRadius - innerRadius) * 1.4;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text
      x={x}
      y={y}
      fill="#64748b"
      textAnchor={x > cx ? "start" : "end"}
      dominantBaseline="central"
      fontSize={12}
    >
      {name} ({(percent * 100).toFixed(0)}%)
    </text>
  );
}

function CenterLabel({ data }: { data: ChatModeDonutChartProps["data"] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <text
      x="50%"
      y="50%"
      textAnchor="middle"
      dominantBaseline="central"
      className="fill-[hsl(var(--card-foreground))]"
    >
      <tspan
        x="50%"
        dy="-0.6em"
        fontSize={11}
        className="fill-[hsl(var(--muted-foreground))]"
      >
        Total
      </tspan>
      <tspan x="50%" dy="1.4em" fontSize={18} fontWeight={600}>
        {total.toLocaleString()}
      </tspan>
    </text>
  );
}

export function ChatModeDonutChart({ data }: ChatModeDonutChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Mode Breakdown</CardTitle>
        <CardDescription>Distribution of chat panel interactions by mode</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-[300px] text-sm text-[hsl(var(--muted-foreground))]">
            No chat mode data available for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={65}
                outerRadius={110}
                paddingAngle={2}
                dataKey="value"
                label={renderLabel}
                labelLine={false}
                strokeWidth={0}
              >
                {data.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={entry.color}
                    fillOpacity={0.85}
                  />
                ))}
              </Pie>
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => v.toLocaleString()}
                  />
                }
              />
              <CenterLabel data={data} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
