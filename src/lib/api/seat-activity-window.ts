/** ISO date string for yesterday in UTC, the latest day metrics APIs report. */
function yesterdayISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

export interface SeatActivityWindow {
  activitySince: string;
  activityUntil: string | null;
  /**
   * True when the window runs up to the present, so the live
   * `last_activity_at` stamp on each seat is a valid basis for the
   * active/inactive split. False for a fully elapsed window, where the split
   * must be derived from recorded per-day usage instead.
   */
  isCurrentWindow: boolean;
}

/**
 * Resolve the activity cutoffs used for live Copilot seat snapshots.
 *
 * `copilot_seats` is not historical data: it contains the seats assigned right
 * now, with each row's latest `last_activity_at` timestamp. That means total
 * seats and pending cancellations cannot be scoped to an old dashboard window.
 *
 * Neither can the active/inactive split, if it is taken from
 * `last_activity_at`. That field is a *latest ever* stamp, so asking whether it
 * falls inside a past month asks "was this person's most recent activity in
 * June?", not "did this person use Copilot in June?" — and everyone still
 * active today answers no. Callers must therefore treat a historical window as
 * a usage question; see `getSeatStatsForWindow`. `isCurrentWindow` is what
 * tells them which case they are in.
 *
 * Current windows are intentionally open-ended. The shared date selector, like
 * the metrics APIs it drives, resolves presets and in-progress calendar months
 * to an end date of yesterday because usage metrics for today are not complete.
 * If seat activity used that same hard upper bound, every seat used today would
 * become inactive on the default/current views even though the seat snapshot is
 * live. To avoid that regression, any window ending yesterday or later has no
 * upper bound and includes today's live seat activity.
 */
export function resolveSeatActivityWindow(start: string, end: string): SeatActivityWindow {
  const isCurrentWindow = end >= yesterdayISO();
  return {
    activitySince: `${start}T00:00:00.000Z`,
    activityUntil: isCurrentWindow ? null : `${end}T23:59:59.999Z`,
    isCurrentWindow,
  };
}
