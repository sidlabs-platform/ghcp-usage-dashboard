import { cn, formatNumber, formatPercent, safeNum } from "@/lib/utils";
import { Card } from "@/components/ui/card";
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
}

const accentColors: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  blue: "border-l-blue-500",
  green: "border-l-emerald-500",
  amber: "border-l-amber-500",
  violet: "border-l-violet-500",
  red: "border-l-red-500",
  teal: "border-l-teal-500",
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
}: MetricCardProps) {
  const displayValue =
    typeof value === "string"
      ? value
      : format === "percent"
        ? formatPercent(value)
        : formatNumber(value);

  return (
    <Card className={cn("relative overflow-hidden", accent && `border-l-[3px] ${accentColors[accent]}`, className)}>
      <div className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{title}</p>
          {icon && (
            <div className="h-8 w-8 rounded-lg bg-[hsl(var(--primary))]/10 flex items-center justify-center text-[hsl(var(--primary))]">
              {icon}
            </div>
          )}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <h3 className="text-3xl font-bold tracking-tight">{displayValue}</h3>
          {delta && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-sm font-medium",
                delta.value > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : delta.value < 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-[hsl(var(--muted-foreground))]"
              )}
            >
              {delta.value > 0 ? (
                <TrendingUp className="h-3.5 w-3.5" />
              ) : delta.value < 0 ? (
                <TrendingDown className="h-3.5 w-3.5" />
              ) : (
                <Minus className="h-3.5 w-3.5" />
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
