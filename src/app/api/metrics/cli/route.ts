import { NextResponse } from "next/server";
import { resolveEnterpriseId, getEnterpriseMetrics, getAllUserMetrics, getAggregatedDailySummary } from "@/lib/db/metrics-repo";
import { getDateRange } from "@/lib/utils";
import { parseScopeFilter, filterByScope } from "@/lib/api/scope-filter";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 7);
    const { start, end } = getDateRange(days);

    const scopeFilter = parseScopeFilter(searchParams);
    const eid = scopeFilter.hasFilter ? null : resolveEnterpriseId();

    const enterpriseRecords = eid ? getEnterpriseMetrics(eid, start, end) : [];
    const aggregated = enterpriseRecords.length === 0 && !scopeFilter.hasFilter ? getAggregatedDailySummary(start, end) : [];
    const userRecords = filterByScope(getAllUserMetrics(start, end), scopeFilter);

    // Daily CLI users and IDE users trend
    // When filtered, build from user-level data instead of enterprise/aggregated
    let dailyTrend;
    if (scopeFilter.hasFilter) {
      const byDay = new Map<string, { cliLogins: Set<string>; ideLogins: Set<string> }>();
      for (const r of userRecords) {
        const entry = byDay.get(r.day) ?? { cliLogins: new Set(), ideLogins: new Set() };
        if (r.used_cli) entry.cliLogins.add(r.user_login);
        else entry.ideLogins.add(r.user_login);
        byDay.set(r.day, entry);
      }
      dailyTrend = Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, sets]) => ({ day, cliUsers: sets.cliLogins.size, ideUsers: sets.ideLogins.size }));
    } else {
      dailyTrend = enterpriseRecords.length > 0
        ? enterpriseRecords.map((d) => ({
            day: d.day,
            cliUsers: d.daily_active_cli_users ?? 0,
            ideUsers: d.daily_active_users - (d.daily_active_cli_users ?? 0),
          }))
        : aggregated.map((d) => ({
            day: d.day,
            cliUsers: d.daily_active_cli_users ?? 0,
            ideUsers: d.daily_active_users - (d.daily_active_cli_users ?? 0),
          }));
    }

    // Daily token/session/request volume from enterprise totals_by_cli
    const dailyTokens = enterpriseRecords.map((d) => {
      const cli = d.totals_by_cli;
      return {
        day: d.day,
        sessions: cli?.session_count ?? 0,
        requests: cli?.request_count ?? 0,
        prompts: cli?.prompt_count ?? 0,
        promptTokens: cli?.token_usage?.prompt_tokens_sum ?? 0,
        outputTokens: cli?.token_usage?.output_tokens_sum ?? 0,
        avgPerRequest: cli?.token_usage?.avg_tokens_per_request ?? 0,
      };
    });

    // Latest day values for KPIs
    const latestAgg = aggregated.length > 0 ? aggregated[aggregated.length - 1] : null;
    const latest = enterpriseRecords.length > 0
      ? enterpriseRecords[enterpriseRecords.length - 1]
      : null;

    const latestCli = latest?.totals_by_cli;

    // Top CLI users: aggregate per user over range
    const userCliMap = new Map<string, { sessions: number; requests: number; prompts: number; promptTokens: number; outputTokens: number; days: number }>();

    for (const r of userRecords) {
      if (!r.used_cli || !r.totals_by_cli) continue;
      const existing = userCliMap.get(r.user_login) ?? {
        sessions: 0, requests: 0, prompts: 0, promptTokens: 0, outputTokens: 0, days: 0,
      };
      existing.sessions += r.totals_by_cli.session_count ?? 0;
      existing.requests += r.totals_by_cli.request_count ?? 0;
      existing.prompts += r.totals_by_cli.prompt_count ?? 0;
      existing.promptTokens += r.totals_by_cli.token_usage?.prompt_tokens_sum ?? 0;
      existing.outputTokens += r.totals_by_cli.token_usage?.output_tokens_sum ?? 0;
      existing.days += 1;
      userCliMap.set(r.user_login, existing);
    }

    const topCliUsers = Array.from(userCliMap.entries())
      .map(([login, stats]) => ({ login, ...stats }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 20);

    return NextResponse.json({
      dailyTrend,
      dailyTokens,
      kpis: {
        dailyCliUsers: latest?.daily_active_cli_users ?? latestAgg?.daily_active_cli_users ?? 0,
        sessionsToday: latestCli?.session_count ?? 0,
        requestsToday: latestCli?.request_count ?? 0,
        avgTokensPerRequest: latestCli?.token_usage?.avg_tokens_per_request ?? 0,
      },
      topCliUsers,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
