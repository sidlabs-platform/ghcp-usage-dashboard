// Seats repository — CRUD for Copilot seat data in SQLite

import { getDb } from "./database";
import type { CopilotSeat } from "@/lib/types/seats";

export function upsertSeat(orgSlug: string, seat: CopilotSeat): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO copilot_seats (
      org_slug, user_login, user_id, plan_type, last_activity_at, last_activity_editor,
      last_authenticated_at, assigning_team_slug, assigning_team_name,
      pending_cancellation_date, created_at, updated_at, avatar_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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

export function upsertSeats(orgSlug: string, seats: CopilotSeat[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO copilot_seats (
      org_slug, user_login, user_id, plan_type, last_activity_at, last_activity_editor,
      last_authenticated_at, assigning_team_slug, assigning_team_name,
      pending_cancellation_date, created_at, updated_at, avatar_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const seat of seats) {
      stmt.run(
        orgSlug, seat.assignee.login, seat.assignee.id, seat.plan_type,
        seat.last_activity_at, seat.last_activity_editor, seat.last_authenticated_at,
        seat.assigning_team?.slug || null, seat.assigning_team?.name || null,
        seat.pending_cancellation_date, seat.created_at, seat.updated_at,
        seat.assignee.avatar_url
      );
    }
  });

  tx();
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

export function getAllSeats(): SeatRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM copilot_seats ORDER BY org_slug, user_login`).all() as SeatRow[];
}

export function getSeatsByOrg(orgSlug: string): SeatRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM copilot_seats WHERE org_slug = ? ORDER BY user_login`).all(orgSlug) as SeatRow[];
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

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM copilot_seats WHERE user_login IN (${placeholders})`
    ).get(...loginsArray) as { total: number };

    const seats = db.prepare(`
      SELECT * FROM copilot_seats
      WHERE user_login IN (${placeholders})
      ORDER BY ${sqlSort} ${sqlDir}
      LIMIT ? OFFSET ?
    `).all(...loginsArray, pageSize, offset) as SeatRow[];

    return { seats, total: countRow.total };
  }

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM copilot_seats`).get() as { total: number };
  const seats = db.prepare(`
    SELECT * FROM copilot_seats
    ORDER BY ${sqlSort} ${sqlDir}
    LIMIT ? OFFSET ?
  `).all(pageSize, offset) as SeatRow[];

  return { seats, total: countRow.total };
}

export function getSeatStats(): { total: number; active30d: number; inactive30d: number; pendingCancellation: number } {
  const db = getDb();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString();

  const total = (db.prepare(`SELECT COUNT(*) as c FROM copilot_seats`).get() as { c: number }).c;
  const active30d = (db.prepare(`SELECT COUNT(*) as c FROM copilot_seats WHERE last_activity_at >= ?`).get(cutoff) as { c: number }).c;
  const pendingCancellation = (db.prepare(`SELECT COUNT(*) as c FROM copilot_seats WHERE pending_cancellation_date IS NOT NULL`).get() as { c: number }).c;

  return {
    total,
    active30d,
    inactive30d: total - active30d,
    pendingCancellation,
  };
}
