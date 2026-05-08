import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseAndClampDays, getDateRange } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

interface MemberRow {
  login: string;
  activeDays: number;
  locAdded: number;
  interactions: number;
  acceptanceRate: number;
  usedAgent: number;
  usedChat: number;
  usedCli: number;
  usedCodeReview: number;
}

async function handler(request: NextRequest) {
  try {
    const slug = decodeURIComponent(request.nextUrl.pathname.split("/").pop() || "");
    if (!slug) {
      return NextResponse.json({ error: "Missing slug parameter" }, { status: 400 });
    }
    const searchParams = request.nextUrl.searchParams;

    const daysResult = parseAndClampDays(searchParams.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { start, end } = getDateRange(daysResult.days);

    const db = getDb();

    // Get team info
    const teamRow = db.prepare(
      `SELECT team_slug, team_name, org_slug FROM team_memberships WHERE team_slug = ? LIMIT 1`,
    ).get(slug) as { team_slug: string; team_name: string; org_slug: string | null } | undefined;

    if (!teamRow) {
      return NextResponse.json(
        { team: null, members: [], aggregates: null },
        { headers: { "Cache-Control": "private, max-age=60" } },
      );
    }

    // Count members
    const countRow = db.prepare(
      `SELECT COUNT(DISTINCT user_login) as cnt FROM team_memberships WHERE team_slug = ?`,
    ).get(slug) as { cnt: number };

    // Get members with metrics from user_period_summary
    const members = db.prepare(`
      SELECT 
        tm.user_login AS login,
        COALESCE(ups.active_days, 0) AS activeDays,
        COALESCE(ups.loc_added, 0) AS locAdded,
        COALESCE(ups.interactions, 0) AS interactions,
        COALESCE(ups.acceptance_rate, 0) AS acceptanceRate,
        COALESCE(ups.used_agent, 0) AS usedAgent,
        COALESCE(ups.used_chat, 0) AS usedChat,
        COALESCE(ups.used_cli, 0) AS usedCli,
        COALESCE(ups.used_code_review_active, 0) AS usedCodeReview
      FROM (SELECT DISTINCT user_login FROM team_memberships WHERE team_slug = ?) tm
      LEFT JOIN user_period_summary ups 
        ON ups.login = tm.user_login AND ups.period_start = ? AND ups.period_end = ?
      ORDER BY activeDays DESC
    `).all(slug, start, end) as MemberRow[];

    // Calculate aggregates from members
    const totalLocAdded = members.reduce((s, m) => s + m.locAdded, 0);
    const nonZeroRates = members.filter((m) => m.acceptanceRate > 0);
    const avgAcceptanceRate =
      nonZeroRates.length > 0
        ? Number((nonZeroRates.reduce((s, m) => s + m.acceptanceRate, 0) / nonZeroRates.length).toFixed(1))
        : 0;
    const memberCount = members.length;
    const pct = (count: number) => (memberCount > 0 ? Number(((count / memberCount) * 100).toFixed(1)) : 0);

    const aggregates = {
      totalLocAdded,
      avgAcceptanceRate,
      agentAdoption: pct(members.filter((m) => m.usedAgent === 1).length),
      chatAdoption: pct(members.filter((m) => m.usedChat === 1).length),
      cliAdoption: pct(members.filter((m) => m.usedCli === 1).length),
      activeMembers: members.filter((m) => m.activeDays > 0).length,
    };

    return NextResponse.json(
      {
        team: {
          slug: teamRow.team_slug,
          name: teamRow.team_name,
          org: teamRow.org_slug,
          memberCount: countRow.cnt,
        },
        members,
        aggregates,
      },
      { headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(
  withCache(handler, CACHE_TTL.MEDIUM),
);
