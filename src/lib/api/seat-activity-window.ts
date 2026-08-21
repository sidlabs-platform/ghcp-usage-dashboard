/** ISO date string for yesterday in UTC, the latest day metrics APIs report. */
function yesterdayISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

export interface SeatActivityWindow {
  activitySince: string;
  activityUntil: string | null;
}

/**
 * Resolve the activity cutoffs used for live Copilot seat snapshots.
 *
 * `copilot_seats` is not historical data: it contains the seats assigned right
 * now, with each row's latest `last_activity_at` timestamp. That means total
 * seats and pending cancellations cannot be scoped to an old dashboard window,
 * but the active/inactive split can ask whether that latest activity happened
 * inside the selected period.
 *
 * Current windows are intentionally open-ended. The shared date selector, like
 * the metrics APIs it drives, resolves presets and in-progress calendar months
 * to an end date of yesterday because usage metrics for today are not complete.
 * If seat activity used that same hard upper bound, every seat used today would
 * become inactive on the default/current views even though the seat snapshot is
 * live. To avoid that regression, any window ending yesterday or later has no
 * upper bound and includes today's live seat activity.
 *
 * Fully historical windows keep their explicit end-of-day upper bound so the
 * activity badge and KPI split describe the elapsed range the reader selected.
 */
export function resolveSeatActivityWindow(start: string, end: string): SeatActivityWindow {
  return {
    activitySince: `${start}T00:00:00.000Z`,
    activityUntil: end >= yesterdayISO() ? null : `${end}T23:59:59.999Z`,
  };
}
