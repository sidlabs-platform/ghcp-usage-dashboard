import { NextResponse } from "next/server";
import { getAllUserMetrics } from "@/lib/db/metrics-repo";
import { getDateRange } from "@/lib/utils";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 90);
    const { start, end } = getDateRange(days);

    const userRecords = getAllUserMetrics(start, end);

    // ── Feature breakdown from totals_by_feature ──────────────────────
    // dailyTrend: { day, [feature]: interaction_count }
    const dailyFeatureMap = new Map<string, Record<string, number>>();
    // featureAgg: { feature -> { interactions, codeGen, codeAccept, locAdded } }
    const featureAgg = new Map<
      string,
      { interactions: number; codeGen: number; codeAccept: number; locAdded: number }
    >();

    // ── Adoption from boolean flags ───────────────────────────────────
    const dailyAdoptionMap = new Map<
      string,
      { agentLogins: Set<string>; chatLogins: Set<string>; cliLogins: Set<string>; allLogins: Set<string> }
    >();
    const periodLogins = { agent: new Set<string>(), chat: new Set<string>(), cli: new Set<string>(), all: new Set<string>() };

    for (const r of userRecords) {
      // -- Feature breakdown --
      const features = r.totals_by_feature ?? [];
      const dayEntry = dailyFeatureMap.get(r.day) ?? {};
      for (const f of features) {
        const name = f.feature;
        // Daily trend: sum interactions per feature per day
        dayEntry[name] = (dayEntry[name] ?? 0) + (f.user_initiated_interaction_count ?? 0);

        // Period totals per feature
        const agg = featureAgg.get(name) ?? { interactions: 0, codeGen: 0, codeAccept: 0, locAdded: 0 };
        agg.interactions += f.user_initiated_interaction_count ?? 0;
        agg.codeGen += f.code_generation_activity_count ?? 0;
        agg.codeAccept += f.code_acceptance_activity_count ?? 0;
        agg.locAdded += f.loc_added_sum ?? 0;
        featureAgg.set(name, agg);
      }
      dailyFeatureMap.set(r.day, dayEntry);

      // -- Adoption flags --
      const login = r.user_login;
      const adopt = dailyAdoptionMap.get(r.day) ?? {
        agentLogins: new Set<string>(),
        chatLogins: new Set<string>(),
        cliLogins: new Set<string>(),
        allLogins: new Set<string>(),
      };
      adopt.allLogins.add(login);
      periodLogins.all.add(login);
      if (r.used_agent) { adopt.agentLogins.add(login); periodLogins.agent.add(login); }
      if (r.used_chat) { adopt.chatLogins.add(login); periodLogins.chat.add(login); }
      if (r.used_cli) { adopt.cliLogins.add(login); periodLogins.cli.add(login); }
      dailyAdoptionMap.set(r.day, adopt);
    }

    // ── Build dailyTrend ──────────────────────────────────────────────
    const dailyTrend = Array.from(dailyFeatureMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, feats]) => ({ day, ...feats }));

    // ── Build featureDistribution ─────────────────────────────────────
    const featureDistribution = Array.from(featureAgg.entries())
      .map(([feature, agg]) => ({ feature, ...agg }))
      .sort((a, b) => (b.interactions + b.codeGen) - (a.interactions + a.codeGen));

    // ── Build adoptionTrend ───────────────────────────────────────────
    const adoptionTrend = Array.from(dailyAdoptionMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, sets]) => ({
        day,
        agentUsers: sets.agentLogins.size,
        chatUsers: sets.chatLogins.size,
        cliUsers: sets.cliLogins.size,
        totalUsers: sets.allLogins.size,
      }));

    // ── Build KPIs ────────────────────────────────────────────────────
    const totalInteractions = featureDistribution.reduce((s, f) => s + f.interactions, 0);
    const totalActivity = featureDistribution.reduce((s, f) => s + f.interactions + f.codeGen, 0);
    const topFeature = featureDistribution.length > 0 ? featureDistribution[0].feature : "N/A";
    const totalUniqueUsers = periodLogins.all.size || 1;

    const kpis = {
      totalInteractions,
      totalActivity,
      topFeature,
      agentAdoptionPct: Number(((periodLogins.agent.size / totalUniqueUsers) * 100).toFixed(1)),
      chatAdoptionPct: Number(((periodLogins.chat.size / totalUniqueUsers) * 100).toFixed(1)),
      cliAdoptionPct: Number(((periodLogins.cli.size / totalUniqueUsers) * 100).toFixed(1)),
    };

    return NextResponse.json({ dailyTrend, featureDistribution, adoptionTrend, kpis });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
