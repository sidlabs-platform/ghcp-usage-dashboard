"use client";

import { useState, useMemo } from "react";
import { useDateRange } from "@/contexts/DateRangeContext";
import { DATE_PRESETS } from "@/lib/constants";
import { MAX_DAYS, cn } from "@/lib/utils";
import { CalendarDays } from "lucide-react";

/**
 * Inline date filter with preset buttons and a custom date-range picker.
 * Reads and writes from DateRangeContext so it stays in sync with the Header.
 */
export function DateFilter() {
  const { mode, days, startDate, endDate, setDays, setCustomRange } = useDateRange();
  const [showCustom, setShowCustom] = useState(false);
  const [localStart, setLocalStart] = useState(startDate);
  const [localEnd, setLocalEnd] = useState(endDate);
  const [error, setError] = useState<string | null>(null);

  const maxDate = useMemo(() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split("T")[0];
  }, []);

  const handleApplyCustom = () => {
    if (!localStart || !localEnd) {
      setError("Both dates are required.");
      return;
    }
    if (localStart > localEnd) {
      setError("Start date must be before end date.");
      return;
    }
    const s = new Date(localStart);
    const e = new Date(localEnd);
    const diff = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    if (diff > MAX_DAYS) {
      setError(`Range cannot exceed ${MAX_DAYS} days.`);
      return;
    }
    setError(null);
    setCustomRange(localStart, localEnd);
    setShowCustom(false);
  };

  const handlePreset = (d: number) => {
    setDays(d);
    setShowCustom(false);
    setError(null);
  };

  const handleToggleCustom = () => {
    if (!showCustom) {
      setLocalStart(startDate);
      setLocalEnd(endDate);
      setError(null);
    }
    setShowCustom(!showCustom);
  };

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Preset buttons */}
        <div className="flex items-center rounded-lg bg-[hsl(var(--muted))] p-1">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.days}
              onClick={() => handlePreset(preset.days)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                mode === "preset" && days === preset.days
                  ? "bg-[hsl(var(--background))] text-[hsl(var(--foreground))] shadow-sm"
                  : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Custom range toggle */}
        <button
          onClick={handleToggleCustom}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors border",
            mode === "custom"
              ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]"
              : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:border-[hsl(var(--foreground)/0.3)]"
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          {mode === "custom" ? `${startDate} — ${endDate}` : "Custom Range"}
        </button>
      </div>

      {/* Custom date picker (collapsible) */}
      {showCustom && (
        <div className="mt-2 flex items-end gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
          <div>
            <label htmlFor="date-filter-start" className="block text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">
              Start Date
            </label>
            <input
              id="date-filter-start"
              type="date"
              value={localStart}
              max={maxDate}
              onChange={(e) => { setLocalStart(e.target.value); setError(null); }}
              className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="date-filter-end" className="block text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">
              End Date
            </label>
            <input
              id="date-filter-end"
              type="date"
              value={localEnd}
              max={maxDate}
              onChange={(e) => { setLocalEnd(e.target.value); setError(null); }}
              className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-sm"
            />
          </div>
          <button
            onClick={handleApplyCustom}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
          >
            Apply
          </button>
          {error && (
            <span className="text-xs text-[hsl(var(--destructive))]">{error}</span>
          )}
        </div>
      )}
    </div>
  );
}
