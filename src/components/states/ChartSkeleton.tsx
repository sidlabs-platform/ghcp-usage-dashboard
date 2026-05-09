export function ChartSkeleton() {
  return (
    <div className="h-80 rounded-xl border bg-[hsl(var(--card))] p-6 flex flex-col justify-end gap-3">
      {/* Y-axis label placeholder */}
      <div className="flex items-end gap-2 flex-1">
        <div className="w-8 flex flex-col justify-between h-full py-2">
          <div className="h-2 w-6 rounded animate-shimmer" />
          <div className="h-2 w-4 rounded animate-shimmer" />
          <div className="h-2 w-6 rounded animate-shimmer" />
        </div>
        {/* Simulated bars */}
        <div className="flex items-end gap-1.5 flex-1 h-full">
          {[40, 65, 50, 80, 55, 70, 45, 75, 60, 85, 50, 65].map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t animate-shimmer"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </div>
      {/* X-axis placeholder */}
      <div className="flex gap-1.5 ml-10">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex-1 h-2 rounded animate-shimmer" />
        ))}
      </div>
    </div>
  );
}

export function KPISkeleton() {
  return (
    <div className="rounded-xl border bg-[hsl(var(--card))] p-6 space-y-3">
      {/* Title line */}
      <div className="h-3 w-24 rounded animate-shimmer" />
      {/* Value line */}
      <div className="h-8 w-32 rounded animate-shimmer" />
      {/* Subtitle line */}
      <div className="h-2.5 w-20 rounded animate-shimmer" />
    </div>
  );
}
