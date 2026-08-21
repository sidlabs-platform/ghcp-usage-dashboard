import { MAX_DAYS, parseAndClampDays } from "@/lib/utils";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Default preset window for the seat lifecycle page. */
export const SEAT_LIFECYCLE_DEFAULT_DAYS = 30;

export interface SeatLifecycleWindow {
  start: string;
  end: string;
  /** True when the caller supplied an explicit start/end override. */
  explicit: boolean;
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

/** Yesterday in UTC as `YYYY-MM-DD` — the latest day metrics APIs will report. */
function yesterdayISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

/**
 * Parse the seat lifecycle time window from query params.
 *
 * Accepts an explicit date override under either the app-wide
 * `startDate`/`endDate` names or this route's original `start`/`end` (both are
 * honoured so existing links and exports keep working), otherwise a `days`
 * preset.
 *
 * Unlike {@link import("@/lib/utils").parseDateRangeParams}, the window
 * **includes today**: a seat can be assigned or removed today and the resulting
 * lifecycle event is recorded with today's date, so clamping to yesterday would
 * silently hide the most recent activity.
 *
 * That is why an explicit end of yesterday-or-later is extended to today. The
 * shared date selector resolves both a rolling preset and an in-progress month
 * to an end of *yesterday*, so without this the page would lose today's events
 * the moment it started honouring the global selector — the exact regression
 * the include-today rule exists to prevent. A fully elapsed past month, or a
 * custom range the reader deliberately ended earlier, is left untouched.
 *
 * @returns `{ start, end, explicit }` or `{ error }` for a 400 response.
 */
export function parseSeatLifecycleWindow(
  params: URLSearchParams,
  defaultDays = SEAT_LIFECYCLE_DEFAULT_DAYS,
): SeatLifecycleWindow | { error: string } {
  const rawStart = params.get("startDate") ?? params.get("start");
  const rawEnd = params.get("endDate") ?? params.get("end");

  if (rawStart || rawEnd) {
    if (!rawStart || !rawEnd) {
      return { error: "Both start and end must be provided together." };
    }
    if (!DATE_RE.test(rawStart) || !DATE_RE.test(rawEnd)) {
      return { error: "start and end must be in YYYY-MM-DD format." };
    }
    const s = new Date(`${rawStart}T00:00:00Z`);
    const e = new Date(`${rawEnd}T00:00:00Z`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      return { error: "start or end is not a valid date." };
    }
    if (s > e) {
      return { error: "start must be on or before end." };
    }
    const spanDays = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
    if (spanDays > MAX_DAYS) {
      return { error: `Date range spans ${spanDays} days, which exceeds the maximum of ${MAX_DAYS}.` };
    }
    const end = rawEnd >= yesterdayISO() ? todayISO() : rawEnd;
    return { start: rawStart, end, explicit: true };
  }

  const daysResult = parseAndClampDays(params.get("days"), defaultDays);
  if ("error" in daysResult) return daysResult;

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - daysResult.days + 1);
  return {
    start: start.toISOString().split("T")[0],
    end: todayISO(),
    explicit: false,
  };
}
