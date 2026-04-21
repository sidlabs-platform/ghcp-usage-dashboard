"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { safeNum } from "@/lib/utils";

interface AutofixInsightChartProps {
  available: number;
  committed: number;
  rate: number;
}

export function AutofixInsightChart({ available, committed, rate }: AutofixInsightChartProps) {
  const data = [
    { name: "Autofix Applied", value: committed, color: "#10b981" },
    { name: "Not Applied", value: Math.max(0, available - committed), color: "#e2e8f0" },
  ];

  return (
    <Card>
      <CardHeader><CardTitle>Copilot Autofix Adoption</CardTitle></CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          <ResponsiveContainer width={120} height={120}>
            <PieChart>
              <Pie data={data} innerRadius={35} outerRadius={50} paddingAngle={2} dataKey="value">
                {data.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="space-y-2">
            <div>
              <p className="text-2xl font-bold">{safeNum(rate).toFixed(1)}%</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Adoption Rate</p>
            </div>
            <div className="flex gap-4 text-sm">
              <div>
                <span className="font-semibold">{available}</span>
                <span className="text-[hsl(var(--muted-foreground))] ml-1">Available</span>
              </div>
              <div>
                <span className="font-semibold text-emerald-600">{committed}</span>
                <span className="text-[hsl(var(--muted-foreground))] ml-1">Applied</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
