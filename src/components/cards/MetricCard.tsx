import { cn, formatNumber, formatPercent, safeNum } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/Sparkline";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface MetricCardProps {
  title: string;
  value: number | string;
  format?: "number" | "percent" | "raw";
  delta?: { value: number; label?: string };
  icon?: React.ReactNode;
  className?: string;
  subtitle?: string;
  accent?: "blue" | "green" | "amber" | "violet" | "red" | "teal";
  trend?: number[];
  trendColor?: string;
  stagger?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
}

const accentColors: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  blue: "border-l-blue-500",
  green: "border-l-emerald-500",
  amber: "border-l-amber-500",
  violet: "border-l-violet-500",
  red: "border-l-red-500",
  teal: "border-l-teal-500",
};

const accentHex: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  blue: "#3b82f6",
  green: "#10b981",
  amber: "#f59e0b",
  violet: "#8b5cf6",
  red: "#ef4444",
  teal: "#14b8a6",
};

const accentGlow: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  blue: "shadow-[inset_3px_0_8px_-4px_rgba(59,130,246,0.4)]",
  green: "shadow-[inset_3px_0_8px_-4px_rgba(16,185,129,0.4)]",
  amber: "shadow-[inset_3px_0_8px_-4px_rgba(245,158,11,0.4)]",
  violet: "shadow-[inset_3px_0_8px_-4px_rgba(139,92,246,0.4)]",
  red: "shadow-[inset_3px_0_8px_-4px_rgba(239,68,68,0.4)]",
  teal: "shadow-[inset_3px_0_8px_-4px_rgba(20,184,166,0.4)]",
};

export function MetricCard({
  title,
  value,
  format = "number",
  delta,
  icon,
  className,
  subtitle,
  accent,
  trend,
  trendColor,
  stagger,
}: MetricCardProps) {
  const displayValue =
    typeof value === "string"
      ? value
      : format === "percent"
        ? formatPercent(value)
        : formatNumber(value);

  const sparkColor = trendColor ?? (accent ? accentHex[accent] : "#3b82f6");

  return (
    <Card
      className={cn(
        "group relative overflow-hidden transition-shadow duration-300 hover:shadow-[var(--card-hover-shadow)]",
        accent && `border-l-[3px] ${accentColors[accent]} ${accentGlow[accent]}`,
        stagger && `animate-fade-in-up stagger-${stagger}`,
        className,
      )}
    >
      {/* Decorative sparkline background */}
      {trend && trend.length > 1 && (
        <div className="pointer-events-none absolute bottom-0 right-0 w-1/2 opacity-[0.18]">
          <Sparkline data={trend} color={sparkColor} height={40} />
        </div>
      )}

      <div className="relative p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{title}</p>
          {icon && (
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[hsl(var(--primary))]"
              style={{
                background: accent
                  ? `linear-gradient(135deg, ${accentHex[accent]}1a, ${accentHex[accent]}0d)`
                  : "hsl(var(--primary) / 0.1)",
              }}
            >
              {icon}
            </div>
          )}
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          <h3 className="tabular-nums text-3xl font-bold tracking-tight">{displayValue}</h3>
          {delta && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
                delta.value > 0
                  ? "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
                  : delta.value < 0
                    ? "bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400"
                    : "bg-[hsl(var(--muted-foreground))]/10 text-[hsl(var(--muted-foreground))]",
              )}
            >
              {delta.value > 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : delta.value < 0 ? (
                <TrendingDown className="h-3 w-3" />
              ) : (
                <Minus className="h-3 w-3" />
              )}
              {delta.value > 0 ? "+" : ""}
              {safeNum(delta.value).toFixed(1)}%
            </span>
          )}
        </div>

        {subtitle && (
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{subtitle}</p>
        )}
      </div>
    </Card>
  );
}
