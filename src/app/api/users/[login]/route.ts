import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseAndClampDays, getDateRange } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

interface DailyActivity {
  day: string;
  codeGen: number;
  codeAccept: number;
  locSuggested: number;
  locAccepted: number;
  interactions: number;
}

interface UserSummary {
  totalActiveDays: number;
  totalLocAdded: number;
  totalLocAccepted: number;
  totalInteractions: number;
  totalCodeGen: number;
  totalCodeAccept: number;
  acceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReview: boolean;
}

interface TopLanguage {
  language: string;
  suggestions: number;
  acceptances: number;
}

interface TopModel {
  model: string;
  interactions: number;
}

interface IdeUsage {
  ide: string;
  users: number;
}

async function handler(request: NextRequest) {
  try {
    const login = request.nextUrl.pathname.split("/").pop();
    if (!login) {
      return NextResponse.json({ error: "Missing login parameter" }, { status: 400 });
    }

    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
    const { start, end } = getDateRange(days);

    const db = getDb();
    const decodedLogin = decodeURIComponent(login);

    // Daily activity
    const dailyActivity = db.prepare(`
      SELECT day,
        COALESCE(code_generation_activity_count, 0) AS codeGen,
        COALESCE(code_acceptance_activity_count, 0) AS codeAccept,
        COALESCE(loc_suggested_to_add_sum, 0) AS locSuggested,
        COALESCE(loc_added_sum, 0) AS locAccepted,
        COALESCE(user_initiated_interaction_count, 0) AS interactions
      FROM user_daily_metrics
      WHERE user_login = ? AND day BETWEEN ? AND ?
      ORDER BY day ASC
    `).all(decodedLogin, start, end) as DailyActivity[];

    // Summary
    const summaryRow = db.prepare(`
      SELECT
        COUNT(DISTINCT day) AS totalActiveDays,
        COALESCE(SUM(loc_suggested_to_add_sum), 0) AS totalLocAdded,
        COALESCE(SUM(loc_added_sum), 0) AS totalLocAccepted,
        COALESCE(SUM(user_initiated_interaction_count), 0) AS totalInteractions,
        COALESCE(SUM(code_generation_activity_count), 0) AS totalCodeGen,
        COALESCE(SUM(code_acceptance_activity_count), 0) AS totalCodeAccept,
        MAX(CASE WHEN used_agent = 1 THEN 1 ELSE 0 END) AS usedAgent,
        MAX(CASE WHEN used_chat = 1 THEN 1 ELSE 0 END) AS usedChat,
        MAX(CASE WHEN used_cli = 1 THEN 1 ELSE 0 END) AS usedCli,
        MAX(CASE WHEN used_copilot_code_review_active = 1 THEN 1 ELSE 0 END) AS usedCodeReview
      FROM user_daily_metrics
      WHERE user_login = ? AND day BETWEEN ? AND ?
    `).get(decodedLogin, start, end) as {
      totalActiveDays: number;
      totalLocAdded: number;
      totalLocAccepted: number;
      totalInteractions: number;
      totalCodeGen: number;
      totalCodeAccept: number;
      usedAgent: number;
      usedChat: number;
      usedCli: number;
      usedCodeReview: number;
    } | undefined;

    let summary: UserSummary | null = null;
    if (summaryRow && summaryRow.totalActiveDays > 0) {
      const rate = summaryRow.totalCodeGen > 0
        ? (summaryRow.totalCodeAccept / summaryRow.totalCodeGen) * 100
        : 0;
      summary = {
        totalActiveDays: summaryRow.totalActiveDays,
        totalLocAdded: summaryRow.totalLocAdded,
        totalLocAccepted: summaryRow.totalLocAccepted,
        totalInteractions: summaryRow.totalInteractions,
        totalCodeGen: summaryRow.totalCodeGen,
        totalCodeAccept: summaryRow.totalCodeAccept,
        acceptanceRate: Math.round(rate * 10) / 10,
        usedAgent: summaryRow.usedAgent === 1,
        usedChat: summaryRow.usedChat === 1,
        usedCli: summaryRow.usedCli === 1,
        usedCodeReview: summaryRow.usedCodeReview === 1,
      };
    }

    // Top languages
    const topLanguages = db.prepare(`
      SELECT
        j.value->>'language' AS language,
        SUM(CAST(COALESCE(j.value->>'code_suggestions', '0') AS INTEGER)) AS suggestions,
        SUM(CAST(COALESCE(j.value->>'code_acceptances', '0') AS INTEGER)) AS acceptances
      FROM user_daily_metrics u, json_each(u.totals_by_language_feature) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?
      GROUP BY language
      ORDER BY suggestions DESC
      LIMIT 10
    `).all(decodedLogin, start, end) as TopLanguage[];

    // Top models
    const topModels = db.prepare(`
      SELECT
        j.value->>'model' AS model,
        SUM(CAST(COALESCE(j.value->>'total_engaged_users', '0') AS INTEGER)) AS interactions
      FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?
      GROUP BY model
      ORDER BY interactions DESC
      LIMIT 10
    `).all(decodedLogin, start, end) as TopModel[];

    // IDE usage
    const ideUsage = db.prepare(`
      SELECT
        j.value->>'name' AS ide,
        SUM(CAST(COALESCE(j.value->>'total_engaged_users', '0') AS INTEGER)) AS users
      FROM user_daily_metrics u, json_each(u.totals_by_ide) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?
      GROUP BY ide
      ORDER BY users DESC
    `).all(decodedLogin, start, end) as IdeUsage[];

    return NextResponse.json({
      user: decodedLogin,
      dailyActivity,
      summary,
      topLanguages,
      topModels,
      ideUsage,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
