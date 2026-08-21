"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { CalendarDays } from "lucide-react";
import { useDateRange } from "@/contexts/DateRangeContext";
import { MAX_DAYS, cn } from "@/lib/utils";

interface CustomRangeFilterProps {
  className?: string;
}

/**
 * Custom start/end date picker bound to `DateRangeContext`.
 *
 * Lives in the header next to the day presets and the month selector so the
 * app has exactly one date control. It previously sat in a separate inline
 * `DateFilter` rendered by five pages, which meant those pages showed two
 * selectors while the rest showed one, and neither control offered the full
 * set of modes.
 */
export function CustomRangeFilter({ className }: Readonly<CustomRangeFilterProps>) {
  const { mode, startDate, endDate, setCustomRange } = useDateRange();
  const [open, setOpen] = useState(false);
  const [localStart, setLocalStart] = useState(startDate);
  const [localEnd, setLocalEnd] = useState(endDate);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const maxDate = useMemo(() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, "0");
    const day = String(yesterday.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);

  // Dismiss on outside click and on Escape so the popover can't be left
  // hanging over the page after the reader has moved on.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const handleToggle = () => {
    if (!open) {
      setLocalStart(startDate);
      setLocalEnd(endDate);
      setError(null);
    }
    setOpen(!open);
  };

  const handleApply = () => {
    if (!localStart || !localEnd) {
      setError("Both dates are required.");
      return;
    }
    if (localStart > localEnd) {
      setError("Start date must be before end date.");
      return;
    }
    if (localStart > maxDate || localEnd > maxDate) {
      setError("Dates cannot be later than yesterday.");
      return;
    }
    const span =
      Math.round(
        (Date.parse(`${localEnd}T00:00:00Z`) - Date.parse(`${localStart}T00:00:00Z`)) / 86_400_000,
      ) + 1;
    if (span > MAX_DAYS) {
      setError(`Range cannot exceed ${MAX_DAYS} days.`);
      return;
    }
    setError(null);
    setCustomRange(localStart, localEnd);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
          mode === "custom"
            ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]"
            : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--foreground)/0.3)] hover:text-[hsl(var(--foreground))]",
        )}
      >
        <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
        {mode === "custom" ? `${startDate} — ${endDate}` : "Custom Range"}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 flex flex-wrap items-end gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 shadow-lg">
          <div>
            <label
              htmlFor="custom-range-start"
              className="mb-1 block text-xs font-medium text-[hsl(var(--muted-foreground))]"
            >
              Start Date
            </label>
            <input
              id="custom-range-start"
              type="date"
              value={localStart}
              max={maxDate}
              onChange={(e) => {
                setLocalStart(e.target.value);
                setError(null);
              }}
              className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            />
          </div>
          <div>
            <label
              htmlFor="custom-range-end"
              className="mb-1 block text-xs font-medium text-[hsl(var(--muted-foreground))]"
            >
              End Date
            </label>
            <input
              id="custom-range-end"
              type="date"
              value={localEnd}
              max={maxDate}
              onChange={(e) => {
                setLocalEnd(e.target.value);
                setError(null);
              }}
              className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            />
          </div>
          <button
            type="button"
            onClick={handleApply}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          >
            Apply
          </button>
          {error && (
            <span role="alert" className="text-xs text-[hsl(var(--destructive))]">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
