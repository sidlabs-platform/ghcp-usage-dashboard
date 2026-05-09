"use client";

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
    dataKey: string;
  }>;
  label?: string;
  labelFormatter?: (label: string) => string;
  valueFormatter?: (value: number, name: string) => string;
}

/** Themed Recharts tooltip — use via `<Tooltip content={<ChartTooltip />} />` */
export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
}: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  const formattedLabel = labelFormatter ? labelFormatter(String(label)) : label;

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl p-3">
      {formattedLabel && (
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-2 font-medium">
          {formattedLabel}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {payload.map((entry, i) => {
          const formatted = valueFormatter
            ? valueFormatter(entry.value, entry.name)
            : entry.value.toLocaleString();
          return (
            <div key={`${entry.dataKey}-${i}`} className="flex items-center gap-2 text-sm">
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-[hsl(var(--muted-foreground))]">{entry.name}</span>
              <span className="ml-auto font-semibold text-[hsl(var(--card-foreground))]">
                {formatted}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
