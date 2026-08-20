"use client";

import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  Suspense,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { DEFAULT_DATE_RANGE_DAYS } from "@/lib/constants";
import { MAX_DAYS, getDateRange } from "@/lib/utils";
import { monthBounds, isValidPeriod, periodOf } from "@/lib/date/month-range";
import {
  parseDateRangeFromURL,
  serializeDateRangeToURL,
  applyParamsToURL,
} from "@/lib/url/params";

type DateRangeMode = "preset" | "custom" | "month";

interface DateRangeContextType {
  /** Current mode: preset (days-based), custom (explicit start/end), or month (calendar period). */
  mode: DateRangeMode;
  /** Days spanned by the active range. In month mode this is the elapsed day count. */
  days: number;
  /** Computed start date (YYYY-MM-DD). */
  startDate: string;
  /** Computed end date (YYYY-MM-DD). */
  endDate: string;
  /**
   * Active billing period as "YYYY-MM" when in month mode, otherwise null.
   *
   * Surfaces that query by billing period (licensing history, billing reports)
   * pass this straight through as `periods` rather than re-deriving a month
   * from `startDate`/`endDate`, so every consumer of a given selection resolves
   * to identical query parameters. That identity is what makes the Billing and
   * License Reconciliation pages agree.
   */
  period: string | null;
  /** Switch to a preset (days-based) range. */
  setDays: (days: number) => void;
  /** Switch to a custom date range. */
  setCustomRange: (start: string, end: string) => void;
  /** Switch to a calendar month, e.g. "2026-08". */
  setMonth: (period: string) => void;
}

const DateRangeContext = createContext<DateRangeContextType>({
  mode: "preset",
  days: DEFAULT_DATE_RANGE_DAYS,
  startDate: "",
  endDate: "",
  period: null,
  setDays: () => {},
  setCustomRange: () => {},
  setMonth: () => {},
});

/** Inclusive day span between two YYYY-MM-DD dates. */
function spanDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (Number.isNaN(ms)) return DEFAULT_DATE_RANGE_DAYS;
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/** Props forwarded to the URL-sync bridge from the provider. */
interface DateRangeURLSyncProps {
  mode: DateRangeMode;
  days: number;
  customStart: string;
  customEnd: string;
  month: string;
}

/**
 * Inner component that bridges the date-range context to the URL.
 *
 * Must be wrapped in `<Suspense>` by the caller because it calls
 * `useSearchParams()`, which Next.js App Router requires to be inside a
 * Suspense boundary during static rendering.
 *
 * Loop avoidance: `lastWrittenRef` tracks the `URLSearchParams.toString()`
 * string that this component last wrote via `router.replace`. When
 * `searchParams` next ticks, the URL→state effect sees that the new URL
 * matches what we wrote and skips re-applying state, breaking the cycle.
 */
function DateRangeURLSync({ mode, days, customStart, customEnd, month }: DateRangeURLSyncProps) {
  const { setDays, setCustomRange, setMonth } = useDateRange();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  /** True once the initial URL read has been applied to state. */
  const initialized = useRef(false);
  /** The URLSearchParams string that we most recently wrote via router.replace. */
  const lastWritten = useRef<string>("");
  /**
   * Always-current snapshot of searchParams, updated before effects run so
   * the state→URL effect can read the latest params without taking
   * searchParams as a dep (which would cause it to fire on every URL change).
   */
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  // Effect 1: URL → state
  // Runs when searchParams changes (navigation, external paste, etc.).
  // Skips when the change was caused by this component itself.
  useEffect(() => {
    const currentStr = searchParams.toString();

    // If we wrote this URL, skip to avoid the write→read→write loop.
    if (initialized.current && currentStr === lastWritten.current) return;

    const parsed = parseDateRangeFromURL(searchParams);
    if (parsed) {
      if (parsed.mode === "preset") setDays(parsed.days);
      else if (parsed.mode === "custom") setCustomRange(parsed.customStart, parsed.customEnd);
      else if (parsed.mode === "month") setMonth(parsed.month);
    }
    initialized.current = true;
  }, [searchParams, setDays, setCustomRange, setMonth]);

  // Effect 2: state → URL
  // Runs when filter state changes. Writes to URL only when the serialised
  // params differ from what is already there.
  useEffect(() => {
    if (!initialized.current) return;

    const updates = serializeDateRangeToURL(mode, days, customStart, customEnd, month);
    const next = applyParamsToURL(searchParamsRef.current, updates);
    const nextStr = next.toString();

    if (nextStr === searchParamsRef.current.toString()) return; // already in sync

    lastWritten.current = nextStr;
    const newUrl = nextStr ? `${pathname}?${nextStr}` : pathname;
    router.replace(newUrl, { scroll: false });
  }, [mode, days, customStart, customEnd, month, pathname, router]);

  return null;
}

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DateRangeMode>("preset");
  const [days, setDaysState] = useState(DEFAULT_DATE_RANGE_DAYS);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [month, setMonthState] = useState<string>(() => periodOf(new Date()));

  const resolved = useMemo(() => {
    if (mode === "month" && isValidPeriod(month)) {
      const latestAvailable = new Date();
      latestAvailable.setUTCDate(latestAvailable.getUTCDate() - 1);
      const { startDate, endDate } = monthBounds(month, latestAvailable);
      return { startDate, endDate, days: spanDays(startDate, endDate), period: month };
    }
    if (mode === "custom" && customStart && customEnd) {
      return {
        startDate: customStart,
        endDate: customEnd,
        days: spanDays(customStart, customEnd),
        period: null,
      };
    }
    const { start, end } = getDateRange(days);
    return { startDate: start, endDate: end, days, period: null };
  }, [mode, days, customStart, customEnd, month]);

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

  const setMonth = useCallback((period: string) => {
    if (!isValidPeriod(period)) return;
    setMonthState(period);
    setMode("month");
  }, []);

  const value = useMemo(
    () => ({
      mode,
      days: resolved.days,
      startDate: resolved.startDate,
      endDate: resolved.endDate,
      period: resolved.period,
      setDays,
      setCustomRange,
      setMonth,
    }),
    [mode, resolved, setDays, setCustomRange, setMonth]
  );

  return (
    <DateRangeContext.Provider value={value}>
      {/* Suspense is required by Next.js App Router when useSearchParams is
          called inside a client component rendered from a server layout. The
          null fallback means the sync is best-effort on first SSR paint and
          activates once the client hydrates — acceptable because filter state
          is a client-only concern. */}
      <Suspense fallback={null}>
        <DateRangeURLSync
          mode={mode}
          days={days}
          customStart={customStart}
          customEnd={customEnd}
          month={month}
        />
      </Suspense>
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange() {
  return useContext(DateRangeContext);
}
