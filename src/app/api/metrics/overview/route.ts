import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseMetrics, getAllUserMetrics, getAggregatedDailySummary, resolveEnterpriseId } from "@/lib/db/metrics-repo";
import { getSeatStats } from "@/lib/db/seats-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { getChatModeSums, getAdoptionStats } from "@/lib/db/aggregation-queries";
import { getDateRange } from "@/lib/utils";
import { extractCompletionMetrics, extractAgentMetrics } from "@/lib/aggregation/separate-metrics";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const days = parseInt(params.get("days") || "7", 10);
    const { start, end } = getDateRange(days);

    const teamsParam = params.get("teams");
    const orgsParam = params.get("orgs");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0;

    // When filters are active, always use user-level aggregation
    const resolvedId = hasFilter ? null : resolveEnterpriseId();
    let metrics = resolvedId ? getEnterpriseMetrics(resolvedId, start, end) : [];

    const useAggregated = metrics.length === 0;
    const aggregated = useAggregated && !hasFilter ? getAggregatedDailySummary(start, end) : [];

    const seatStats = getSeatStats();
    let userRecords = getAllUserMetrics(start, end);

    // Apply team/org filter to user records
    let allowedLogins: Set<string> | null = null;
    let allowedLoginsArray: string[] | undefined;
    if (hasFilter) {
      allowedLoginsArray = resolveFilteredUsers(selectedTeams, selectedOrgs);
      allowedLogins = new Set(allowedLoginsArray);
      userRecords = userRecords.filter((r) => allowedLogins!.has(r.user_login));
    }

    let activeUsersTrend;
    let acceptanceRateTrend;
    let featureUsage;
    let cliVsIde;

    if (hasFilter) {
      // Build all trends from filtered user data
      const byDay = new Map<string, typeof userRecords>();
      for (const r of userRecords) {
        const arr = byDay.get(r.day) ?? [];
        arr.push(r);
        byDay.set(r.day, arr);
      }
      const sortedDays = Array.from(byDay.keys()).sort();

      activeUsersTrend = sortedDays.map((day) => {
        const dayRecords = byDay.get(day)!;
        const daily = new Set(dayRecords.map((r) => r.user_login)).size;
        // WAU: distinct users active in last 7 days
        const wauStart = new Date(day);
        wauStart.setDate(wauStart.getDate() - 6);
        const wauStartStr = wauStart.toISOString().slice(0, 10);
        const weekUsers = new Set<string>();
        for (const d of sortedDays) {
          if (d >= wauStartStr && d <= day) {
            for (const r of byDay.get(d)!) weekUsers.add(r.user_login);
          }
        }
        return { day, daily, weekly: weekUsers.size, monthly: daily };
      });

      acceptanceRateTrend = sortedDays.map((day) => {
        const dayRecords = byDay.get(day)!;
        // Acceptance rate = code completion only (excludes agent_edit)
        let compSuggested = 0, compAccepted = 0, agentAdded = 0;
        for (const r of dayRecords) {
          const comp = extractCompletionMetrics(r.totals_by_feature || []);
          const agent = extractAgentMetrics(r.totals_by_feature || []);
          compSuggested += comp.locSuggested;
          compAccepted += comp.locAccepted;
          agentAdded += agent.locAdded;
        }
        return {
          day,
          suggested: compSuggested,
          accepted: compAccepted,
          agentAdded,
          rate: compSuggested > 0 ? (compAccepted / compSuggested) * 100 : 0,
        };
      });

      featureUsage = sortedDays.map((day) => {
        const dayRecords = byDay.get(day)!;
        return {
          day,
          completions: dayRecords.reduce((s, r) => s + r.code_generation_activity_count, 0),
          chat: dayRecords.filter((r) => r.used_chat).length,
          agent: dayRecords.filter((r) => r.used_agent).length,
          cli: dayRecords.filter((r) => r.used_cli).length,
        };
      });

      cliVsIde = sortedDays.map((day) => {
        const dayRecords = byDay.get(day)!;
        return {
          day,
          ideUsers: new Set(dayRecords.map((r) => r.user_login)).size,
          cliUsers: dayRecords.filter((r) => r.used_cli).length,
        };
      });
    } else if (useAggregated) {
      // Build from user-level data for correct completion-only acceptance rate
      const byDay = new Map<string, typeof userRecords>();
      for (const r of userRecords) {
        const arr = byDay.get(r.day) ?? [];
        arr.push(r);
        byDay.set(r.day, arr);
      }
      const sortedDays = Array.from(byDay.keys()).sort();

      activeUsersTrend = aggregated.map((d) => ({
        day: d.day,
        daily: d.daily_active_users,
        weekly: d.daily_active_users,
        monthly: d.daily_active_users,
      }));

      acceptanceRateTrend = sortedDays.map((day) => {
        const dayRecords = byDay.get(day) || [];
        let compSuggested = 0, compAccepted = 0, agentAdded = 0;
        for (const r of dayRecords) {
          const comp = extractCompletionMetrics(r.totals_by_feature || []);
          const agent = extractAgentMetrics(r.totals_by_feature || []);
          compSuggested += comp.locSuggested;
          compAccepted += comp.locAccepted;
          agentAdded += agent.locAdded;
        }
        return {
          day,
          suggested: compSuggested,
          accepted: compAccepted,
          agentAdded,
          rate: compSuggested > 0 ? (compAccepted / compSuggested) * 100 : 0,
        };
      });

      featureUsage = aggregated.map((d) => ({
        day: d.day,
        completions: d.code_generation_activity_count,
        chat: d.chat_users,
        agent: d.agent_users,
        cli: d.daily_active_cli_users,
      }));

      cliVsIde = aggregated.map((d) => ({
        day: d.day,
        ideUsers: d.daily_active_users,
        cliUsers: d.daily_active_cli_users || 0,
      }));
    } else {
      activeUsersTrend = metrics.map((d) => ({
        day: d.day,
        daily: d.daily_active_users,
        weekly: d.weekly_active_users,
        monthly: d.monthly_active_users,
      }));

      acceptanceRateTrend = metrics.map((d) => {
        const comp = extractCompletionMetrics(d.totals_by_feature || []);
        const agent = extractAgentMetrics(d.totals_by_feature || []);
        return {
          day: d.day,
          suggested: comp.locSuggested,
          accepted: comp.locAccepted,
          agentAdded: agent.locAdded,
          rate: comp.locSuggested > 0 ? (comp.locAccepted / comp.locSuggested) * 100 : 0,
        };
      });

      featureUsage = metrics.map((d) => {
        const completions = (d.totals_by_feature || []).find((f) => f.feature === "code_completion");
        const chat = (d.totals_by_feature || []).find((f) => f.feature === "chat_panel");
        return {
          day: d.day,
          completions: completions?.code_generation_activity_count || 0,
          chat: chat?.user_initiated_interaction_count || 0,
          agent: d.monthly_active_agent_users || 0,
          cli: d.daily_active_cli_users || 0,
        };
      });

      cliVsIde = metrics.map((d) => ({
        day: d.day,
        ideUsers: d.daily_active_users,
        cliUsers: d.daily_active_cli_users || 0,
      }));
    }

    // Chat mode distribution via SQL aggregation
    const chatModes = getChatModeSums(start, end, allowedLoginsArray);

    // Adoption stats via SQL aggregation
    const adoption = getAdoptionStats(start, end, allowedLoginsArray);

    // KPIs
    const latestTrend = activeUsersTrend[activeUsersTrend.length - 1];
    const prevTrend = activeUsersTrend.length > 1 ? activeUsersTrend[activeUsersTrend.length - 2] : null;

    const kpis = {
      dailyActiveUsers: latestTrend?.daily || 0,
      weeklyActiveUsers: latestTrend?.weekly || 0,
      monthlyActiveUsers: hasFilter
        ? adoption.totalUsers
        : (useAggregated
          ? adoption.totalUsers
          : (metrics[metrics.length - 1] as { monthly_active_users?: number })?.monthly_active_users || 0),
      agentAdoption: adoption.totalUsers > 0 ? (adoption.agentUsers / adoption.totalUsers) * 100 : 0,
      codingAgentAdoption: adoption.totalUsers > 0 ? (adoption.codingAgentUsers / adoption.totalUsers) * 100 : 0,
      codeReviewAdoption: adoption.totalUsers > 0 ? (adoption.codeReviewUsers / adoption.totalUsers) * 100 : 0,
      cliUsers: latestTrend ? cliVsIde[cliVsIde.length - 1]?.cliUsers || 0 : 0,
      licenseUtilization: hasFilter
        ? -1 // Indicate N/A when filtered
        : (seatStats.total > 0 ? (seatStats.active30d / seatStats.total) * 100 : 0),
      deltas: {
        dau: prevTrend && prevTrend.daily > 0
          ? ((latestTrend!.daily - prevTrend.daily) / prevTrend.daily) * 100 : 0,
        wau: 0,
      },
    };

    const totalDays = activeUsersTrend.length;

    return NextResponse.json({
      kpis,
      activeUsersTrend,
      acceptanceRateTrend,
      chatModes,
      featureUsage,
      cliVsIde,
      dataAsOf: end,
      daysLoaded: totalDays,
      dataSource: hasFilter ? "filtered-users" : (useAggregated ? "user-aggregated" : "enterprise"),
      filtered: hasFilter,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
