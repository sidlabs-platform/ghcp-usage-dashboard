"use client";

import { useMemo } from "react";
import { useDateRange } from "@/contexts/DateRangeContext";
import { recentPeriods, periodLabel, isPartialMonth } from "@/lib/date/month-range";
import { CalendarRange } from "lucide-react";
import { cn } from "@/lib/utils";

/** How many calendar months the selector offers. */
const MONTH_OPTIONS = 12;

interface MonthSelectorProps {
  /**
   * Periods known to hold data, newest first. When supplied, the selector
   * offers exactly these instead of the trailing twelve months, so the reader
   * is never invited to pick a month that can only render empty.
   */
  availablePeriods?: string[];
  /** Rendered before the control; omit on surfaces that already say "Month". */
  label?: string;
  className?: string;
  id?: string;
}

/**
 * Calendar-month picker bound to `DateRangeContext`.
 *
 * Billing and licensing are billed and reported on calendar cycles, so a
 * rolling "last N days" window can't express the question those pages answer
 * ("what did August cost?"). Selecting a month here switches the whole app to
 * that period, which is also what makes the Billing and License &amp; Credits
 * pages reconcile: both resolve to the same `period` and the same day bounds.
 */
export function MonthSelector({
  availablePeriods,
  label = "Month",
  className,
  id = "month-selector",
}: Readonly<MonthSelectorProps>) {
  const { mode, period, setMonth } = useDateRange();

  const options = useMemo(() => {
    if (availablePeriods && availablePeriods.length > 0) {
      return [...availablePeriods].sort().reverse();
    }
    return recentPeriods(MONTH_OPTIONS);
  }, [availablePeriods]);

  // In days/custom mode nothing is selected yet; show a placeholder rather
  // than implying a month is active when the figures are a rolling window.
  const value = mode === "month" && period ? period : "";
  const partial = mode === "month" && period ? isPartialMonth(period) : false;

  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <label htmlFor={id} className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
        {label}
      </label>
      <div className="relative inline-flex items-center">
        <CalendarRange className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
        <select
          id={id}
          value={value}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
          className={cn(
            "appearance-none rounded-md border py-1.5 pl-8 pr-8 text-xs font-medium transition-colors",
            "bg-[hsl(var(--background))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
            mode === "month"
              ? "border-[hsl(var(--primary))] text-[hsl(var(--foreground))]"
              : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]"
          )}
        >
          {value === "" && <option value="">Select month…</option>}
          {options.map((p) => (
            <option key={p} value={p}>
              {periodLabel(p)}
            </option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 text-[10px] text-[hsl(var(--muted-foreground))]"
        >
          ▼
        </span>
      </div>
      {partial && (
        <span
          className="rounded-full bg-[hsl(var(--muted))] px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--muted-foreground))]"
          title="This month is still in progress, so it covers fewer days than a complete month."
        >
          Month to date
        </span>
      )}
    </div>
  );
}
