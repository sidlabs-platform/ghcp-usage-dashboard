"use client";

import { createContext, useContext, useState, useMemo, useCallback, type ReactNode } from "react";
import { DEFAULT_DATE_RANGE_DAYS } from "@/lib/constants";
import { MAX_DAYS, getDateRange } from "@/lib/utils";

type DateRangeMode = "preset" | "custom";

interface DateRangeContextType {
  /** Current mode: preset (days-based) or custom (explicit start/end). */
  mode: DateRangeMode;
  /** Number of days when in preset mode. */
  days: number;
  /** Computed start date (YYYY-MM-DD). */
  startDate: string;
  /** Computed end date (YYYY-MM-DD). */
  endDate: string;
  /** Switch to a preset (days-based) range. */
  setDays: (days: number) => void;
  /** Switch to a custom date range. */
  setCustomRange: (start: string, end: string) => void;
}

const DateRangeContext = createContext<DateRangeContextType>({
  mode: "preset",
  days: DEFAULT_DATE_RANGE_DAYS,
  startDate: "",
  endDate: "",
  setDays: () => {},
  setCustomRange: () => {},
});

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DateRangeMode>("preset");
  const [days, setDaysState] = useState(DEFAULT_DATE_RANGE_DAYS);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const { startDate, endDate } = useMemo(() => {
    if (mode === "custom" && customStart && customEnd) {
      return { startDate: customStart, endDate: customEnd };
    }
    const { start, end } = getDateRange(days);
    return { startDate: start, endDate: end };
  }, [mode, days, customStart, customEnd]);

  const setDays = useCallback((d: number) => {
    const clamped = Math.max(1, Math.min(d, MAX_DAYS));
    setDaysState(clamped);
    setMode("preset");
  }, []);

  const setCustomRange = useCallback((start: string, end: string) => {
    setCustomStart(start);
    setCustomEnd(end);
    setMode("custom");
  }, []);

  return (
    <DateRangeContext.Provider value={{ mode, days, startDate, endDate, setDays, setCustomRange }}>
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange() {
  return useContext(DateRangeContext);
}
