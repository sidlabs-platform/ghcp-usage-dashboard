// Seats repository — CRUD for Copilot seat data in SQLite

import { getDb } from "./database";
import type { CopilotSeat } from "@/lib/types/seats";

function buildEnterpriseFilter(slugs?: string[], prefix = "WHERE"): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` ${prefix} enterprise_slug IN (${placeholders})`, params: slugs };
}

export function upsertSeat(enterpriseSlug: string, orgSlug: string, seat: CopilotSeat): void {
  if (!seat.assignee?.login) return; // skip seats with missing assignee (e.g., deleted users)
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO copilot_seats (
      enterprise_slug, org_slug, user_login, user_id, plan_type, last_activity_at, last_activity_editor,
      last_authenticated_at, assigning_team_slug, assigning_team_name,
      pending_cancellation_date, created_at, updated_at, avatar_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    enterpriseSlug,
    orgSlug,
    seat.assignee.login,
    seat.assignee.id,
    seat.plan_type,
    seat.last_activity_at,
    seat.last_activity_editor,
    seat.last_authenticated_at,
    seat.assigning_team?.slug || null,
    seat.assigning_team?.name || null,
    seat.pending_cancellation_date,
    seat.created_at,
    seat.updated_at,
    seat.assignee.avatar_url
  );
}

export function upsertSeats(enterpriseSlug: string, orgSlug: string, seats: CopilotSeat[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO copilot_seats (
      enterprise_slug, org_slug, user_login, user_id, plan_type, last_activity_at, last_activity_editor,
      last_authenticated_at, assigning_team_slug, assigning_team_name,
      pending_cancellation_date, created_at, updated_at, avatar_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const seat of seats) {
      if (!seat.assignee?.login) continue; // skip seats with missing assignee (e.g., deleted users)
      stmt.run(
        enterpriseSlug, orgSlug, seat.assignee.login, seat.assignee.id, seat.plan_type,
        seat.last_activity_at, seat.last_activity_editor, seat.last_authenticated_at,
        seat.assigning_team?.slug || null, seat.assigning_team?.name || null,
        seat.pending_cancellation_date, seat.created_at, seat.updated_at,
        seat.assignee.avatar_url
      );
    }
  });

  tx();
}

/**
 * Replace the current Copilot seat snapshot for an enterprise.
 */
export function replaceEnterpriseSeats(
  enterpriseSlug: string,
  seatsByOrg: Map<string, CopilotSeat[]>,
): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO copilot_seats (
      enterprise_slug, org_slug, user_login, user_id, plan_type, last_activity_at, last_activity_editor,
      last_authenticated_at, assigning_team_slug, assigning_team_name,
      pending_cancellation_date, created_at, updated_at, avatar_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM copilot_seats WHERE enterprise_slug = ?").run(enterpriseSlug);
    for (const [orgSlug, seats] of seatsByOrg) {
      if (!orgSlug) continue;
      for (const seat of seats) {
        if (!seat.assignee?.login) continue;
        stmt.run(
          enterpriseSlug, orgSlug, seat.assignee.login, seat.assignee.id, seat.plan_type,
          seat.last_activity_at, seat.last_activity_editor, seat.last_authenticated_at,
          seat.assigning_team?.slug || null, seat.assigning_team?.name || null,
          seat.pending_cancellation_date, seat.created_at, seat.updated_at,
          seat.assignee.avatar_url
        );
        inserted++;
      }
    }
  });

  tx();
  return inserted;
}

export interface SeatRow {
  org_slug: string;
  user_login: string;
  user_id: number;
  plan_type: string;
  last_activity_at: string | null;
  last_activity_editor: string | null;
  assigning_team_slug: string | null;
  assigning_team_name: string | null;
  pending_cancellation_date: string | null;
  created_at: string;
  avatar_url: string | null;
}

export function getAllSeats(enterpriseSlugs?: string[]): SeatRow[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  return db.prepare(`SELECT * FROM copilot_seats${ef.clause} ORDER BY org_slug, user_login`).all(...ef.params) as SeatRow[];
}

export function getSeatsByOrg(orgSlug: string, enterpriseSlugs?: string[]): SeatRow[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs, "AND");
  return db.prepare(`SELECT * FROM copilot_seats WHERE org_slug = ?${ef.clause} ORDER BY user_login`).all(orgSlug, ...ef.params) as SeatRow[];
}

export interface PaginatedSeats {
  seats: SeatRow[];
  total: number;
}

export function getSeatsPaginated(
  page: number,
  pageSize: number,
  sortField: string,
  sortDir: "asc" | "desc",
  allowedLogins?: Set<string>,
  enterpriseSlugs?: string[],
): PaginatedSeats {
  const db = getDb();

  const sortColumns: Record<string, string> = {
    user_login: "user_login",
    org_slug: "org_slug",
    plan_type: "plan_type",
    _lastActivity: "last_activity_at",
    last_activity_editor: "last_activity_editor",
  };
  const sqlSort = sortColumns[sortField] || "last_activity_at";
  const sqlDir = sortDir === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;

  if (allowedLogins && allowedLogins.size > 0) {
    const loginsArray = Array.from(allowedLogins);
    const placeholders = loginsArray.map(() => "?").join(",");
    const ef = buildEnterpriseFilter(enterpriseSlugs, "AND");

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM copilot_seats WHERE user_login IN (${placeholders})${ef.clause}`
    ).get(...loginsArray, ...ef.params) as { total: number };

    const seats = db.prepare(`
      SELECT * FROM copilot_seats
      WHERE user_login IN (${placeholders})${ef.clause}
      ORDER BY ${sqlSort} ${sqlDir}
      LIMIT ? OFFSET ?
    `).all(...loginsArray, ...ef.params, pageSize, offset) as SeatRow[];

    return { seats, total: countRow.total };
  }

  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM copilot_seats${ef.clause}`).get(...ef.params) as { total: number };
  const seats = db.prepare(`
    SELECT * FROM copilot_seats${ef.clause}
    ORDER BY ${sqlSort} ${sqlDir}
    LIMIT ? OFFSET ?
  `).all(...ef.params, pageSize, offset) as SeatRow[];

  return { seats, total: countRow.total };
}

export interface SeatStats {
  /**
   * Distinct people holding a Copilot seat right now.
   *
   * Counted as `COUNT(DISTINCT LOWER(user_login))`, not `COUNT(*)`: the
   * `copilot_seats` primary key includes `org_slug`, so a user who belongs to
   * several orgs in the same enterprise produces several rows. Counting rows
   * over-stated this fleet by 31% (1,595 rows for 1,219 people) and inflated
   * every derived figure — seat totals, the utilization denominator and the
   * inactive count.
   */
  total: number;
  /** Seats with activity at or after the cutoff. Named for the default 30-day window. */
  active30d: number;
  inactive30d: number;
  pendingCancellation: number;
  /** The activity cutoff actually applied, as an ISO timestamp. */
  activitySince: string;
  /** Optional inclusive upper bound applied to activity, or null for current windows. */
  activityUntil: string | null;
  /**
   * How the active/inactive split was derived.
   *
   * `"last_activity"` — from each seat's live `last_activity_at` stamp. Only
   * meaningful for a window that runs up to now.
   * `"usage"` — from recorded per-day usage inside the window. The only
   * correct basis for a historical window; see {@link getSeatStatsForWindow}.
   */
  activityBasis: "last_activity" | "usage";
}

/**
 * Seat counts plus an activity split.
 *
 * `copilot_seats` is a *live snapshot* — it holds today's seat assignments and
 * no history — so `total` and `pendingCancellation` always describe now, no
 * matter what window is selected. Callers must present the two differently;
 * see the Seat Management page.
 *
 * The active/inactive split here is derived from `last_activity_at`, which is
 * each seat's *latest ever* activity, refreshed on every sync. That makes it
 * valid only for a window running up to now. For a historical window use
 * {@link getSeatStatsForWindow}, which derives the split from recorded usage
 * instead.
 *
 * @param enterpriseSlugs Restrict to these enterprises.
 * @param activitySince ISO timestamp; seats active at or after it count as
 *   active. Defaults to 30 days ago so existing callers are unaffected.
 * @param activityUntil Optional inclusive ISO timestamp; when provided, seats
 *   active after it do not count as active. Omitted by default so current
 *   live-snapshot behavior remains unchanged.
 */
export function getSeatStats(
  enterpriseSlugs?: string[],
  activitySince?: string,
  activityUntil?: string | null,
): SeatStats {
  const db = getDb();
  let cutoff = activitySince;
  if (!cutoff) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    cutoff = thirtyDaysAgo.toISOString();
  }
  const upperBound = activityUntil || null;

  const efW = buildEnterpriseFilter(enterpriseSlugs);
  const efA = buildEnterpriseFilter(enterpriseSlugs, "AND");
  const activityUpperClause = upperBound ? " AND last_activity_at <= ?" : "";
  const activeParams = upperBound
    ? [cutoff, upperBound, ...efA.params]
    : [cutoff, ...efA.params];

  const total = (db.prepare(`SELECT COUNT(DISTINCT LOWER(user_login)) as c FROM copilot_seats${efW.clause}`).get(...efW.params) as { c: number }).c;
  const active30d = (db.prepare(`SELECT COUNT(DISTINCT LOWER(user_login)) as c FROM copilot_seats WHERE last_activity_at >= ?${activityUpperClause}${efA.clause}`).get(...activeParams) as { c: number }).c;
  const pendingCancellation = (db.prepare(`SELECT COUNT(DISTINCT LOWER(user_login)) as c FROM copilot_seats WHERE pending_cancellation_date IS NOT NULL${efA.clause}`).get(...efA.params) as { c: number }).c;

  return {
    total,
    active30d,
    inactive30d: total - active30d,
    pendingCancellation,
    activitySince: cutoff,
    activityUntil: upperBound,
    activityBasis: "last_activity",
  };
}

/**
 * Seat counts whose active/inactive split describes the *selected window*.
 *
 * This exists because `copilot_seats.last_activity_at` is a single
 * latest-ever timestamp on a live snapshot, not a history. Asking whether that
 * one stamp falls inside a past month answers the wrong question: everyone
 * still using Copilot today carries a *today* stamp, so they fall outside the
 * month and get counted as inactive. Selecting June 2026 in August reported 48
 * active and 1,547 inactive seats — and a 3% license utilization — for a fleet
 * where 1,077 seat holders actually used Copilot that June.
 *
 * So for a historical window the split is derived from `user_daily_metrics`,
 * which *is* per-day history: a seat is active if that person has a recorded
 * usage row inside the window. `total` and `pendingCancellation` still describe
 * now, because the snapshot has no history to offer — callers must label them
 * as such.
 *
 * A window that runs up to the present keeps the cheaper `last_activity_at`
 * basis, which also picks up activity newer than the last metrics sync.
 *
 * @param isCurrentWindow When true, use the live `last_activity_at` basis.
 */
export function getSeatStatsForWindow(
  startDay: string,
  endDay: string,
  isCurrentWindow: boolean,
  enterpriseSlugs?: string[],
  activitySince?: string,
  activityUntil?: string | null,
): SeatStats {
  if (isCurrentWindow) {
    return getSeatStats(enterpriseSlugs, activitySince, activityUntil);
  }

  const db = getDb();
  const efW = buildEnterpriseFilter(enterpriseSlugs);
  const efA = buildEnterpriseFilter(enterpriseSlugs, "AND");

  const total = (db.prepare(
    `SELECT COUNT(DISTINCT LOWER(user_login)) as c FROM copilot_seats${efW.clause}`,
  ).get(...efW.params) as { c: number }).c;

  const pendingCancellation = (db.prepare(
    `SELECT COUNT(DISTINCT LOWER(user_login)) as c FROM copilot_seats WHERE pending_cancellation_date IS NOT NULL${efA.clause}`,
  ).get(...efA.params) as { c: number }).c;

  // Enterprise scoping is applied to the seat side only. A seat holder counts
  // as active on the strength of any recorded usage in the window, regardless
  // of which enterprise reported it, so a user whose seat sits in one
  // enterprise is not marked inactive because their usage was reported under
  // another.
  const active30d = (db.prepare(
    `SELECT COUNT(*) as c FROM (
       SELECT DISTINCT LOWER(user_login) AS login FROM copilot_seats${efW.clause}
     ) s
     WHERE s.login IN (
       SELECT DISTINCT LOWER(user_login) FROM user_daily_metrics WHERE day >= ? AND day <= ?
     )`,
  ).get(...efW.params, startDay, endDay) as { c: number }).c;

  return {
    total,
    active30d,
    inactive30d: total - active30d,
    pendingCancellation,
    activitySince: `${startDay}T00:00:00.000Z`,
    activityUntil: `${endDay}T23:59:59.999Z`,
    activityBasis: "usage",
  };
}

/**
 * Distinct users with recorded usage in the window who hold no seat in the
 * current `copilot_seats` snapshot.
 *
 * Active-user counts come from usage metrics while seat counts come from a live
 * snapshot, so the two populations do not have to match — a user whose seat was
 * removed, or whose organization's seat sync is failing, appears in one and not
 * the other. Left unreported this shows up as "1,464 active users" beside "1,219
 * seats", which reads as a bug rather than as two different measurements.
 */
export function countActiveUsersWithoutSeat(
  startDay: string,
  endDay: string,
  enterpriseSlugs?: string[],
): number {
  const db = getDb();
  const efW = buildEnterpriseFilter(enterpriseSlugs);
  const efU = buildEnterpriseFilter(enterpriseSlugs, "AND");

  const row = db.prepare(
    `SELECT COUNT(*) as c FROM (
       SELECT DISTINCT LOWER(user_login) AS login
       FROM user_daily_metrics
       WHERE day >= ? AND day <= ?${efU.clause}
     ) u
     WHERE u.login NOT IN (
       SELECT DISTINCT LOWER(user_login) FROM copilot_seats${efW.clause}
     )`,
  ).get(startDay, endDay, ...efU.params, ...efW.params) as { c: number } | undefined;

  return row?.c ?? 0;
}
