"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface SecurityTrendChartProps {
  title: string;
  data: { day: string; opened: number; fixed: number; total_open: number }[];
  fixedLabel?: string;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function SecurityTrendChart({ title, data, fixedLabel = "Fixed" }: SecurityTrendChartProps) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="day" tickFormatter={formatDate} tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <Tooltip labelFormatter={(l) => `Date: ${l}`} formatter={(v: number, n: string) => [v.toLocaleString(), n]} />
            <Legend />
            <Line type="monotone" dataKey="opened" name="Opened" stroke="#ef4444" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="fixed" name={fixedLabel} stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="total_open" name="Total Open" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 4 }} strokeDasharray="5 5" />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
