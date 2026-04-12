"use client";

import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
} from "recharts";

interface BillingChargeScopeChartProps {
  userNet: number;
  orgNet: number;
}

const COLORS = { user: "#3b82f6", org: "#10b981" };

const fmtCurrency = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(2)}`;

function CenterLabel({ viewBox, total }: { viewBox?: { cx: number; cy: number }; total: string }) {
  if (!viewBox) return null;
  const { cx, cy } = viewBox;
  return (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
      <tspan x={cx} dy="-0.5em" fontSize={14} fill="hsl(var(--muted-foreground))">
        Total
      </tspan>
      <tspan x={cx} dy="1.4em" fontSize={18} fontWeight={600} fill="hsl(var(--foreground))">
        {total}
      </tspan>
    </text>
  );
}

export function BillingChargeScopeChart({ userNet, orgNet }: BillingChargeScopeChartProps) {
  if (userNet === 0 && orgNet === 0)
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No data available
      </div>
    );

  const total = userNet + orgNet;
  const segments = [
    { name: "User", value: userNet, color: COLORS.user },
    { name: "Org", value: orgNet, color: COLORS.org },
  ];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={segments}
          cx="50%"
          cy="50%"
          innerRadius={70}
          outerRadius={110}
          paddingAngle={2}
          dataKey="value"
          label={({ name, percent }: { name: string; percent: number }) =>
            `${name} (${(percent * 100).toFixed(0)}%)`
          }
          labelLine={false}
        >
          {segments.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Pie>
        <Pie
          data={[{ value: 1 }]}
          cx="50%"
          cy="50%"
          innerRadius={0}
          outerRadius={0}
          dataKey="value"
          fill="none"
          label={<CenterLabel total={fmtCurrency(total)} />}
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
          }}
          formatter={(value: number, name: string) => [fmtCurrency(value), name]}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
