export function ChartSkeleton() {
  return (
    <div className="h-80 rounded-xl border bg-[hsl(var(--card))] animate-pulse flex items-center justify-center">
      <span className="text-sm text-[hsl(var(--muted-foreground))]">Loading chart...</span>
    </div>
  );
}
