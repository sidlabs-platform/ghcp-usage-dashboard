import { NextResponse } from "next/server";
import { resolveEnterpriseId, getEnterpriseMetrics, getAllUserMetrics } from "@/lib/db/metrics-repo";
import { getDateRange } from "@/lib/utils";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 7);
    const { start, end } = getDateRange(days);
    const eid = resolveEnterpriseId();

    let records = eid ? getEnterpriseMetrics(eid, start, end) : [];

    // Fallback: build from user-level data if no enterprise-level data
    if (records.length === 0) {
      const userRecords = getAllUserMetrics(start, end);
      // Group by day and aggregate totals_by_ide and totals_by_language_feature
      const dayMap = new Map<string, { totals_by_ide: Record<string, unknown>[]; totals_by_language_feature: Record<string, unknown>[] }>();
      for (const u of userRecords) {
        if (!dayMap.has(u.day)) dayMap.set(u.day, { totals_by_ide: [], totals_by_language_feature: [] });
        const entry = dayMap.get(u.day)!;
        if (u.totals_by_ide) entry.totals_by_ide.push(...(u.totals_by_ide as unknown as Record<string, unknown>[]));
        if (u.totals_by_language_feature) entry.totals_by_language_feature.push(...(u.totals_by_language_feature as unknown as Record<string, unknown>[]));
      }
      records = Array.from(dayMap.entries()).map(([day, data]) => ({
        day,
        enterprise_id: eid || "",
        daily_active_users: 0, weekly_active_users: 0, monthly_active_users: 0,
        monthly_active_agent_users: 0, monthly_active_chat_users: 0,
        code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0,
        loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0,
        totals_by_ide: data.totals_by_ide as never[],
        totals_by_feature: [], totals_by_language_feature: data.totals_by_language_feature as never[],
        totals_by_model_feature: [], totals_by_language_model: [],
      }));
    }

    // Aggregate IDE totals across all days
    const ideMap = new Map<string, { locAdded: number; locDeleted: number; interactions: number; generations: number; acceptances: number }>();
    // Aggregate language totals across all days
    const langMap = new Map<string, { locAdded: number; locDeleted: number; generations: number; acceptances: number }>();
    // IDE trend per day
    const ideTrend: { day: string; [ide: string]: string | number }[] = [];

    for (const d of records) {
      const dayIde: Record<string, number> = {};

      for (const ide of d.totals_by_ide ?? []) {
        const existing = ideMap.get(ide.ide) ?? { locAdded: 0, locDeleted: 0, interactions: 0, generations: 0, acceptances: 0 };
        existing.locAdded += ide.loc_added_sum;
        existing.locDeleted += ide.loc_deleted_sum;
        existing.interactions += ide.user_initiated_interaction_count;
        existing.generations += ide.code_generation_activity_count;
        existing.acceptances += ide.code_acceptance_activity_count;
        ideMap.set(ide.ide, existing);

        dayIde[ide.ide] = (dayIde[ide.ide] ?? 0) + ide.user_initiated_interaction_count;
      }

      ideTrend.push({ day: d.day, ...dayIde });

      for (const lf of d.totals_by_language_feature ?? []) {
        const existing = langMap.get(lf.language) ?? { locAdded: 0, locDeleted: 0, generations: 0, acceptances: 0 };
        existing.locAdded += lf.loc_added_sum;
        existing.locDeleted += lf.loc_deleted_sum;
        existing.generations += lf.code_generation_activity_count;
        existing.acceptances += lf.code_acceptance_activity_count;
        langMap.set(lf.language, existing);
      }
    }

    const ideDistribution = Array.from(ideMap.entries())
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.interactions - a.interactions);

    const languageDistribution = Array.from(langMap.entries())
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.locAdded - a.locAdded);

    // Collect all IDE names for trend chart
    const allIdes = [...new Set(ideDistribution.map((i) => i.name))];

    return NextResponse.json({
      ideDistribution,
      languageDistribution,
      ideTrend,
      allIdes,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
