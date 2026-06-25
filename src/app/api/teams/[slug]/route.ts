import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseDateRangeParams } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import type { MemberRow, TeamDetailResponse } from "@/lib/types/team-detail";

async function handler(request: NextRequest) {
  try {
    const slug = decodeURIComponent(request.nextUrl.pathname.split("/").pop() || "");
    if (!slug) {
      return NextResponse.json({ error: "Missing slug parameter" }, { status: 400 });
    }
    const searchParams = request.nextUrl.searchParams;

    const rangeResult = parseDateRangeParams(searchParams, 7);
    if ("error" in rangeResult) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }
    const { start, end } = rangeResult;

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

    // Aggregate member metrics directly from user_daily_metrics, scoped to team members.
    // Acceptance rate uses completion-only features (excludes agent_edit) via json_each.
    const members = db.prepare(`
      WITH team_logins AS (
        SELECT DISTINCT user_login FROM team_memberships WHERE team_slug = ?
      ),
      member_metrics AS (
        SELECT
          udm.user_login,
          COUNT(DISTINCT udm.day) AS active_days,
          SUM(udm.loc_added_sum) AS loc_added,
          SUM(udm.user_initiated_interaction_count) AS interactions,
          MAX(udm.used_agent) AS used_agent,
          MAX(udm.used_chat) AS used_chat,
          MAX(udm.used_cli) AS used_cli,
          MAX(udm.used_copilot_code_review_active) AS used_code_review
        FROM user_daily_metrics udm
        INNER JOIN team_logins tl ON tl.user_login = udm.user_login
        WHERE udm.day >= ? AND udm.day <= ?
        GROUP BY udm.user_login
      ),
      completion_rates AS (
        SELECT
          udm.user_login,
          COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) AS comp_gen,
          COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) AS comp_accept
        FROM user_daily_metrics udm
        INNER JOIN team_logins tl ON tl.user_login = udm.user_login,
        json_each(udm.totals_by_feature) j
        WHERE udm.day >= ? AND udm.day <= ?
          AND udm.totals_by_feature IS NOT NULL AND udm.totals_by_feature != '[]'
          AND COALESCE(json_extract(j.value, '$.feature'), '') != 'agent_edit'
        GROUP BY udm.user_login
      )
      SELECT
        tl.user_login AS login,
        COALESCE(mm.active_days, 0) AS activeDays,
        COALESCE(mm.loc_added, 0) AS locAdded,
        COALESCE(mm.interactions, 0) AS interactions,
        CASE
          WHEN COALESCE(cr.comp_gen, 0) > 0
          THEN ROUND(CAST(cr.comp_accept AS REAL) / cr.comp_gen * 100, 1)
          ELSE 0
        END AS acceptanceRate,
        COALESCE(mm.used_agent, 0) AS usedAgent,
        COALESCE(mm.used_chat, 0) AS usedChat,
        COALESCE(mm.used_cli, 0) AS usedCli,
        COALESCE(mm.used_code_review, 0) AS usedCodeReview
      FROM team_logins tl
      LEFT JOIN member_metrics mm ON mm.user_login = tl.user_login
      LEFT JOIN completion_rates cr ON cr.user_login = tl.user_login
      ORDER BY activeDays DESC
    `).all(slug, start, end, start, end) as MemberRow[];

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
