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
  total: number;
  /** Seats with activity at or after the cutoff. Named for the default 30-day window. */
  active30d: number;
  inactive30d: number;
  pendingCancellation: number;
  /** The activity cutoff actually applied, as an ISO timestamp. */
  activitySince: string;
}

/**
 * Seat counts plus an activity split.
 *
 * `copilot_seats` is a *live snapshot* — it holds today's seat assignments and
 * no history — so `total` and `pendingCancellation` always describe now, no
 * matter what window is selected. Only the active/inactive split can honour a
 * window, because `last_activity_at` is a real timestamp on each seat row.
 * Callers must present the two differently; see the Seat Management page.
 *
 * @param enterpriseSlugs Restrict to these enterprises.
 * @param activitySince ISO timestamp; seats active at or after it count as
 *   active. Defaults to 30 days ago so existing callers are unaffected.
 */
export function getSeatStats(enterpriseSlugs?: string[], activitySince?: string): SeatStats {
  const db = getDb();
  let cutoff = activitySince;
  if (!cutoff) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    cutoff = thirtyDaysAgo.toISOString();
  }

  const efW = buildEnterpriseFilter(enterpriseSlugs);
  const efA = buildEnterpriseFilter(enterpriseSlugs, "AND");

  const total = (db.prepare(`SELECT COUNT(*) as c FROM copilot_seats${efW.clause}`).get(...efW.params) as { c: number }).c;
  const active30d = (db.prepare(`SELECT COUNT(*) as c FROM copilot_seats WHERE last_activity_at >= ?${efA.clause}`).get(cutoff, ...efA.params) as { c: number }).c;
  const pendingCancellation = (db.prepare(`SELECT COUNT(*) as c FROM copilot_seats WHERE pending_cancellation_date IS NOT NULL${efA.clause}`).get(...efA.params) as { c: number }).c;

  return {
    total,
    active30d,
    inactive30d: total - active30d,
    pendingCancellation,
    activitySince: cutoff,
  };
}
