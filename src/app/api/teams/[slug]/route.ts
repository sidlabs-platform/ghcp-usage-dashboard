import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseDateRangeParams } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import type { MemberRow, TeamDetailResponse } from "@/lib/types/team-detail";
// Shared completion-feature allowlist SQL fragment — the single source of
// truth for "is this feature a completion feature" across all raw SQL call
// sites. Never re-declare a local copy or fall back to a bare
// `!= 'agent_edit'` exclusion, since that would silently misclassify
// `copilot_app`, `chat_inline`, or any future unknown feature as completion.
import { IS_ACCEPTANCE_ELIGIBLE_SQL } from "@/lib/db/aggregation-queries";

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

    const source = searchParams.get("source");
    const enterprise = searchParams.get("enterprise");
    
    const db = getDb();

    // Get team info
    let teamRowSql = `SELECT team_slug, team_name, org_slug FROM team_memberships WHERE team_slug = ?`;
    const teamRowParams: any[] = [slug];
    if (source) {
      teamRowSql += ` AND source = ?`;
      teamRowParams.push(source);
    }
    if (enterprise) {
      teamRowSql += ` AND enterprise_slug = ?`;
      teamRowParams.push(enterprise);
    }
    teamRowSql += ` LIMIT 1`;
    
    const teamRow = db.prepare(teamRowSql).get(...teamRowParams) as { team_slug: string; team_name: string; org_slug: string | null } | undefined;

    if (!teamRow) {
      return NextResponse.json(
        { team: null, members: [], aggregates: null },
        { headers: { "Cache-Control": "private, max-age=60" } },
      );
    }

    // Count members
    let countRowSql = `SELECT COUNT(DISTINCT LOWER(user_login)) as cnt FROM team_memberships WHERE team_slug = ?`;
    const countRowParams: any[] = [slug];
    if (source) {
      countRowSql += ` AND source = ?`;
      countRowParams.push(source);
    }
    if (enterprise) {
      countRowSql += ` AND enterprise_slug = ?`;
      countRowParams.push(enterprise);
    }
    const countRow = db.prepare(countRowSql).get(...countRowParams) as { cnt: number };

    // Aggregate member metrics directly from user_daily_metrics, scoped to team members.
    // Acceptance rate uses the explicit completion allowlist (code_completion,
    // inline_chat, chat_panel, chat_panel_*) via json_each — not a bare
    // `!= 'agent_edit'` exclusion — so copilot_app/chat_inline/unknown features
    // never leak into a team member's completion acceptance rate.
    let teamLoginsSql = `SELECT LOWER(user_login) AS login_key, MIN(user_login) AS user_login FROM team_memberships WHERE team_slug = ?`;
    const teamLoginsParams: any[] = [slug];
    if (source) {
      teamLoginsSql += ` AND source = ?`;
      teamLoginsParams.push(source);
    }
    if (enterprise) {
      teamLoginsSql += ` AND enterprise_slug = ?`;
      teamLoginsParams.push(enterprise);
    }
    teamLoginsSql += ` GROUP BY LOWER(user_login)`;

    const members = db.prepare(`
      WITH team_logins AS (
        ${teamLoginsSql}
      ),
      member_metrics AS (
        SELECT
          LOWER(udm.user_login) AS login_key,
          COUNT(DISTINCT udm.day) AS active_days,
          SUM(udm.loc_added_sum) AS loc_added,
          SUM(udm.user_initiated_interaction_count) AS interactions,
          MAX(udm.used_agent) AS used_agent,
          MAX(udm.used_chat) AS used_chat,
          MAX(udm.used_cli) AS used_cli,
          MAX(udm.used_copilot_code_review_active) AS used_code_review
        FROM user_daily_metrics udm
        INNER JOIN team_logins tl ON tl.login_key = LOWER(udm.user_login)
        WHERE udm.day >= ? AND udm.day <= ?
        GROUP BY LOWER(udm.user_login)
      ),
      completion_rates AS (
        SELECT
          LOWER(udm.user_login) AS login_key,
          COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) AS comp_gen,
          COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) AS comp_accept
        FROM user_daily_metrics udm
        INNER JOIN team_logins tl ON tl.login_key = LOWER(udm.user_login),
        json_each(udm.totals_by_feature) j
        WHERE udm.day >= ? AND udm.day <= ?
          AND udm.totals_by_feature IS NOT NULL AND udm.totals_by_feature != '[]'
          AND json_valid(udm.totals_by_feature)
          AND ${IS_ACCEPTANCE_ELIGIBLE_SQL}
        GROUP BY LOWER(udm.user_login)
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
      LEFT JOIN member_metrics mm ON mm.login_key = tl.login_key
      LEFT JOIN completion_rates cr ON cr.login_key = tl.login_key
      ORDER BY activeDays DESC
    `).all(...teamLoginsParams, start, end, start, end) as MemberRow[];

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

import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
export const GET = withRateLimit(withTimeout(
  withCache(handler, CACHE_TTL.MEDIUM),
));
