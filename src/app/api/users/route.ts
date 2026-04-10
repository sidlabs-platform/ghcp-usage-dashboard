import { NextResponse } from "next/server";
import { getAllUserMetrics } from "@/lib/db/metrics-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { getDateRange } from "@/lib/utils";
import { extractCompletionMetrics } from "@/lib/aggregation/separate-metrics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 7);
    const { start, end } = getDateRange(days);

    const teamsParam = searchParams.get("teams");
    const orgsParam = searchParams.get("orgs");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0;

    let allRecords = getAllUserMetrics(start, end);

    if (hasFilter) {
      const allowedLogins = new Set(resolveFilteredUsers(selectedTeams, selectedOrgs));
      allRecords = allRecords.filter((r) => allowedLogins.has(r.user_login));
    }

    // Group records by user login
    const byUser = new Map<string, typeof allRecords>();
    for (const r of allRecords) {
      const arr = byUser.get(r.user_login) ?? [];
      arr.push(r);
      byUser.set(r.user_login, arr);
    }

    const users = Array.from(byUser.entries()).map(([login, records]) => {
      const activeDays = records.length;
      const locAdded = records.reduce((s, r) => s + r.loc_added_sum, 0);
      const locDeleted = records.reduce((s, r) => s + r.loc_deleted_sum, 0);
      const interactions = records.reduce((s, r) => s + r.user_initiated_interaction_count, 0);
      // Completion-only acceptance rate (excludes agent_edit)
      const compMetrics = records.reduce((acc, r) => {
        const comp = extractCompletionMetrics(r.totals_by_feature || []);
        return { codeGen: acc.codeGen + comp.codeGenCount, codeAccept: acc.codeAccept + comp.codeAcceptCount };
      }, { codeGen: 0, codeAccept: 0 });
      const usedAgent = records.some((r) => r.used_agent);
      const usedChat = records.some((r) => r.used_chat);
      const usedCli = records.some((r) => r.used_cli);
      const usedCodeReviewActive = records.some((r) => r.used_copilot_code_review_active);
      const usedCodeReviewPassive = records.some((r) => r.used_copilot_code_review_passive);
      const usedCodingAgent = records.some((r) => r.used_copilot_coding_agent);
      const acceptanceRate = compMetrics.codeGen > 0 ? Number(((compMetrics.codeAccept / compMetrics.codeGen) * 100).toFixed(1)) : 0;

      return {
        login, activeDays, locAdded, locDeleted, interactions,
        codeGen: compMetrics.codeGen, codeAccept: compMetrics.codeAccept,
        acceptanceRate, usedAgent, usedChat, usedCli,
        usedCodeReviewActive, usedCodeReviewPassive, usedCodingAgent,
      };
    });

    return NextResponse.json({ users }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
