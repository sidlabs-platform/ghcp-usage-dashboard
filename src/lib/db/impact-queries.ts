import { getDb } from "./database";

// ── Interfaces ────────────────────────────────────────────────────────

export interface PrDailyTrendRow {
  day: string;
  medianMergeMinutes: number;
  medianMergeCopilotAuthored: number;
  medianMergeCopilotReviewed: number;
  totalPrs: number;
  copilotAuthoredPrs: number;
  copilotReviewedPrs: number;
}

export interface PrEfficiencyResult {
  daily: PrDailyTrendRow[];
  kpis: {
    avgMergeMinutes: number;
    avgMergeCopilotAuthored: number;
    avgMergeCopilotReviewed: number;
    copilotAuthoredPercent: number;
    copilotReviewedPercent: number;
    totalPrs: number;
  };
}

export interface AgentDailyTrendRow {
  day: string;
  agentUsers: number;
  codingAgentUsers: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  totalLocAdded: number;
  totalLocDeleted: number;
}

export interface AgentImpactResult {
  daily: AgentDailyTrendRow[];
  kpis: {
    totalAgentUsers: number;
    totalCodingAgentUsers: number;
    agentLocAdded: number;
    agentLocDeleted: number;
    totalLocAdded: number;
    totalLocDeleted: number;
    agentLocPercent: number;
  };
}

export interface LicenseDailyTrendRow {
  day: string;
  activeUsers: number;
  totalUsers: number;
}

export interface LicenseUtilizationResult {
  kpis: {
    totalSeats: number;
    activeLast30d: number;
    inactiveSeats: number;
    pendingCancellation: number;
    utilizationPercent: number;
  };
  daily: LicenseDailyTrendRow[];
}

export interface CodeReviewDailyTrendRow {
  day: string;
  totalReviewedByCopilot: number;
  totalSuggestions: number;
  totalAppliedSuggestions: number;
  codeReviewActiveUsers: number;
  codeReviewPassiveUsers: number;
}

export interface CodeReviewImpactResult {
  daily: CodeReviewDailyTrendRow[];
  kpis: {
    totalReviewedByCopilot: number;
    totalSuggestions: number;
    totalAppliedSuggestions: number;
    suggestionAcceptanceRate: number;
    codeReviewActiveUsers: number;
    codeReviewPassiveUsers: number;
  };
}

export interface EngagementDepthResult {
  distribution: { featureCount: number; userCount: number }[];
  averageDepth: number;
  totalUsers: number;
}

export interface TimeToValueResult {
  distribution: { daysBucket: string; userCount: number }[];
  averageDays: number;
  medianDays: number;
  totalUsers: number;
}

export interface AdoptionFunnelResult {
  totalSeats: number;
  activeUsers: number;
  regularUsers: number;
  powerUsers: number;
}

export interface HealthScoreResult {
  adoptionRate: number;
  acceptanceRate: number;
  featureBreadth: number;
  engagementFrequency: number;
  overallScore: number;
}

// ── Filter helpers (mirror aggregation-queries.ts) ────────────────────

function buildLoginFilter(allowedLogins: string[]): { clause: string; params: string[] } {
  if (allowedLogins.length === 0) return { clause: "", params: [] };
  const placeholders = allowedLogins.map(() => "?").join(",");
  return { clause: `AND user_login IN (${placeholders})`, params: allowedLogins };
}

function buildEnterpriseFilter(slugs?: string[]): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND enterprise_slug IN (${placeholders})`, params: slugs };
}

// ── Helpers ───────────────────────────────────────────────────────────

interface PullRequestsJson {
  total_prs_merged?: number;
  total_copilot_authored_prs?: number;
  total_copilot_reviewed_prs?: number;
  total_reviewed_by_copilot?: number;
  total_copilot_suggestions?: number;
  total_copilot_applied_suggestions?: number;
  median_minutes_to_merge?: number;
  median_minutes_to_merge_copilot_authored?: number;
  median_minutes_to_merge_copilot_reviewed?: number;
}

function safeParsePr(raw: string | null | undefined): PullRequestsJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PullRequestsJson;
  } catch {
    return null;
  }
}

// ── 1. PR Efficiency Metrics ──────────────────────────────────────────

/**
 * Retrieve PR efficiency metrics comparing merge times for Copilot-authored
 * vs Copilot-reviewed PRs from enterprise_daily_metrics.pull_requests JSON.
 * Returns empty results when allowedLogins is provided (enterprise-level only).
 */
export function getPrEfficiencyMetrics(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): PrEfficiencyResult {
  const empty: PrEfficiencyResult = {
    daily: [],
    kpis: {
      avgMergeMinutes: 0,
      avgMergeCopilotAuthored: 0,
      avgMergeCopilotReviewed: 0,
      copilotAuthoredPercent: 0,
      copilotReviewedPercent: 0,
      totalPrs: 0,
    },
  };

  // Enterprise-level aggregates only — skip when org/team filtering is active
  if (allowedLogins && allowedLogins.length > 0) return empty;

  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT day, pull_requests
    FROM enterprise_daily_metrics
    WHERE day >= ? AND day <= ?
      AND pull_requests IS NOT NULL
      ${ef.clause}
    ORDER BY day ASC
  `;
  const rows = db.prepare(sql).all(startDay, endDay, ...ef.params) as Array<{
    day: string;
    pull_requests: string;
  }>;

  if (rows.length === 0) return empty;

  const daily: PrDailyTrendRow[] = [];
  let sumMerge = 0;
  let sumMergeAuthored = 0;
  let sumMergeReviewed = 0;
  let mergeDays = 0;
  let mergeAuthoredDays = 0;
  let mergeReviewedDays = 0;
  let totalPrs = 0;
  let totalAuthored = 0;
  let totalReviewed = 0;

  for (const row of rows) {
    const pr = safeParsePr(row.pull_requests);
    if (!pr) continue;

    const dayRow: PrDailyTrendRow = {
      day: row.day,
      medianMergeMinutes: pr.median_minutes_to_merge ?? 0,
      medianMergeCopilotAuthored: pr.median_minutes_to_merge_copilot_authored ?? 0,
      medianMergeCopilotReviewed: pr.median_minutes_to_merge_copilot_reviewed ?? 0,
      totalPrs: pr.total_prs_merged ?? 0,
      copilotAuthoredPrs: pr.total_copilot_authored_prs ?? 0,
      copilotReviewedPrs: pr.total_copilot_reviewed_prs ?? 0,
    };
    daily.push(dayRow);

    totalPrs += dayRow.totalPrs;
    totalAuthored += dayRow.copilotAuthoredPrs;
    totalReviewed += dayRow.copilotReviewedPrs;

    if (dayRow.medianMergeMinutes > 0) {
      sumMerge += dayRow.medianMergeMinutes;
      mergeDays++;
    }
    if (dayRow.medianMergeCopilotAuthored > 0) {
      sumMergeAuthored += dayRow.medianMergeCopilotAuthored;
      mergeAuthoredDays++;
    }
    if (dayRow.medianMergeCopilotReviewed > 0) {
      sumMergeReviewed += dayRow.medianMergeCopilotReviewed;
      mergeReviewedDays++;
    }
  }

  return {
    daily,
    kpis: {
      avgMergeMinutes: mergeDays > 0 ? Number((sumMerge / mergeDays).toFixed(1)) : 0,
      avgMergeCopilotAuthored: mergeAuthoredDays > 0 ? Number((sumMergeAuthored / mergeAuthoredDays).toFixed(1)) : 0,
      avgMergeCopilotReviewed: mergeReviewedDays > 0 ? Number((sumMergeReviewed / mergeReviewedDays).toFixed(1)) : 0,
      copilotAuthoredPercent: totalPrs > 0 ? Number(((totalAuthored / totalPrs) * 100).toFixed(1)) : 0,
      copilotReviewedPercent: totalPrs > 0 ? Number(((totalReviewed / totalPrs) * 100).toFixed(1)) : 0,
      totalPrs,
    },
  };
}

// ── 2. Agent Impact Metrics ───────────────────────────────────────────

/**
 * Compute agent impact metrics: LoC from agent_edit vs total LoC,
 * agent adoption trend, and coding-agent user counts.
 */
export function getAgentImpactMetrics(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): AgentImpactResult {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  // Daily trend
  const dailySql = `
    SELECT
      day,
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_coding_agent = 1 THEN user_login END) as codingAgentUsers,
      COALESCE(SUM(CASE WHEN agent_edit IS NOT NULL
        THEN json_extract(agent_edit, '$.loc_added_sum') ELSE 0 END), 0) as agentLocAdded,
      COALESCE(SUM(CASE WHEN agent_edit IS NOT NULL
        THEN json_extract(agent_edit, '$.loc_deleted_sum') ELSE 0 END), 0) as agentLocDeleted,
      COALESCE(SUM(loc_added_sum), 0) as totalLocAdded,
      COALESCE(SUM(loc_deleted_sum), 0) as totalLocDeleted
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  const daily = db.prepare(dailySql).all(startDay, endDay, ...filter.params, ...ef.params) as AgentDailyTrendRow[];

  // KPIs
  const kpiSql = `
    SELECT
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as totalAgentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_coding_agent = 1 THEN user_login END) as totalCodingAgentUsers,
      COALESCE(SUM(CASE WHEN agent_edit IS NOT NULL
        THEN json_extract(agent_edit, '$.loc_added_sum') ELSE 0 END), 0) as agentLocAdded,
      COALESCE(SUM(CASE WHEN agent_edit IS NOT NULL
        THEN json_extract(agent_edit, '$.loc_deleted_sum') ELSE 0 END), 0) as agentLocDeleted,
      COALESCE(SUM(loc_added_sum), 0) as totalLocAdded,
      COALESCE(SUM(loc_deleted_sum), 0) as totalLocDeleted
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
  `;
  const kpiRow = db.prepare(kpiSql).get(startDay, endDay, ...filter.params, ...ef.params) as {
    totalAgentUsers: number;
    totalCodingAgentUsers: number;
    agentLocAdded: number;
    agentLocDeleted: number;
    totalLocAdded: number;
    totalLocDeleted: number;
  };

  const totalLoc = kpiRow.totalLocAdded + kpiRow.totalLocDeleted;
  const agentLoc = kpiRow.agentLocAdded + kpiRow.agentLocDeleted;

  return {
    daily,
    kpis: {
      ...kpiRow,
      agentLocPercent: totalLoc > 0 ? Number(((agentLoc / totalLoc) * 100).toFixed(1)) : 0,
    },
  };
}

// ── 3. License Utilization Metrics ────────────────────────────────────

/**
 * Compute license utilization from copilot_seats (current snapshot)
 * and daily_aggregate_cache (utilization over time).
 */
export function getLicenseUtilizationMetrics(
  enterpriseSlugs?: string[],
): LicenseUtilizationResult {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  // Seat KPIs
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString();

  const seatEf = ef.clause ? ef.clause.replace(" AND ", " WHERE ") : "";
  const seatsSql = `
    SELECT
      COUNT(*) as totalSeats,
      COUNT(CASE WHEN last_activity_at IS NOT NULL AND last_activity_at > ? THEN 1 END) as activeLast30d,
      COUNT(CASE WHEN last_activity_at IS NULL OR last_activity_at <= ? THEN 1 END) as inactiveSeats,
      COUNT(CASE WHEN pending_cancellation_date IS NOT NULL THEN 1 END) as pendingCancellation
    FROM copilot_seats
    ${seatEf}
  `;
  const seatParams = [cutoff, cutoff, ...ef.params];
  const seatRow = db.prepare(seatsSql).get(...seatParams) as {
    totalSeats: number;
    activeLast30d: number;
    inactiveSeats: number;
    pendingCancellation: number;
  };

  // DAU trend from daily_aggregate_cache (last 90 days)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const trendStart = ninetyDaysAgo.toISOString().slice(0, 10);

  const trendSql = `
    SELECT
      day,
      COALESCE(SUM(active_users), 0) as activeUsers,
      COALESCE(SUM(total_users), 0) as totalUsers
    FROM daily_aggregate_cache
    WHERE day >= ? ${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  const daily = db.prepare(trendSql).all(trendStart, ...ef.params) as LicenseDailyTrendRow[];

  return {
    kpis: {
      ...seatRow,
      utilizationPercent: seatRow.totalSeats > 0
        ? Number(((seatRow.activeLast30d / seatRow.totalSeats) * 100).toFixed(1))
        : 0,
    },
    daily,
  };
}

// ── 4. Code Review Impact Metrics ─────────────────────────────────────

/**
 * Compute Copilot code review impact: suggestion counts, acceptance rate,
 * and active/passive review user counts.
 * Enterprise-level PR data skipped when allowedLogins is provided.
 */
export function getCodeReviewImpactMetrics(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CodeReviewImpactResult {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  // User-level code review adoption (works with allowedLogins)
  const userDailySql = `
    SELECT
      day,
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_active = 1 THEN user_login END) as codeReviewActiveUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_passive = 1 THEN user_login END) as codeReviewPassiveUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  const userDaily = db.prepare(userDailySql).all(
    startDay, endDay, ...filter.params, ...ef.params,
  ) as Array<{ day: string; codeReviewActiveUsers: number; codeReviewPassiveUsers: number }>;

  const userKpiSql = `
    SELECT
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_active = 1 THEN user_login END) as codeReviewActiveUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_passive = 1 THEN user_login END) as codeReviewPassiveUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
  `;
  const userKpi = db.prepare(userKpiSql).get(
    startDay, endDay, ...filter.params, ...ef.params,
  ) as { codeReviewActiveUsers: number; codeReviewPassiveUsers: number };

  // Enterprise-level PR review data (skip if user-level filtering)
  if (allowedLogins && allowedLogins.length > 0) {
    const daily: CodeReviewDailyTrendRow[] = userDaily.map((d) => ({
      day: d.day,
      totalReviewedByCopilot: 0,
      totalSuggestions: 0,
      totalAppliedSuggestions: 0,
      codeReviewActiveUsers: d.codeReviewActiveUsers,
      codeReviewPassiveUsers: d.codeReviewPassiveUsers,
    }));
    return {
      daily,
      kpis: {
        totalReviewedByCopilot: 0,
        totalSuggestions: 0,
        totalAppliedSuggestions: 0,
        suggestionAcceptanceRate: 0,
        ...userKpi,
      },
    };
  }

  // Fetch enterprise-level PR review stats
  const prSql = `
    SELECT day, pull_requests
    FROM enterprise_daily_metrics
    WHERE day >= ? AND day <= ?
      AND pull_requests IS NOT NULL
      ${ef.clause}
    ORDER BY day ASC
  `;
  const prRows = db.prepare(prSql).all(startDay, endDay, ...ef.params) as Array<{
    day: string;
    pull_requests: string;
  }>;

  // Index user daily data by day for merging
  const userDayMap = new Map<string, { active: number; passive: number }>();
  for (const u of userDaily) {
    userDayMap.set(u.day, {
      active: u.codeReviewActiveUsers,
      passive: u.codeReviewPassiveUsers,
    });
  }

  const daily: CodeReviewDailyTrendRow[] = [];
  let totalReviewed = 0;
  let totalSuggestions = 0;
  let totalApplied = 0;

  // Collect all days from both sources
  const allDays = new Set<string>();
  for (const r of prRows) allDays.add(r.day);
  for (const u of userDaily) allDays.add(u.day);
  const sortedDays = Array.from(allDays).sort();

  const prDayMap = new Map<string, PullRequestsJson>();
  for (const r of prRows) {
    const pr = safeParsePr(r.pull_requests);
    if (pr) prDayMap.set(r.day, pr);
  }

  for (const day of sortedDays) {
    const pr = prDayMap.get(day);
    const userD = userDayMap.get(day);
    const reviewed = pr?.total_reviewed_by_copilot ?? 0;
    const suggestions = pr?.total_copilot_suggestions ?? 0;
    const applied = pr?.total_copilot_applied_suggestions ?? 0;

    daily.push({
      day,
      totalReviewedByCopilot: reviewed,
      totalSuggestions: suggestions,
      totalAppliedSuggestions: applied,
      codeReviewActiveUsers: userD?.active ?? 0,
      codeReviewPassiveUsers: userD?.passive ?? 0,
    });

    totalReviewed += reviewed;
    totalSuggestions += suggestions;
    totalApplied += applied;
  }

  return {
    daily,
    kpis: {
      totalReviewedByCopilot: totalReviewed,
      totalSuggestions,
      totalAppliedSuggestions: totalApplied,
      suggestionAcceptanceRate: totalSuggestions > 0
        ? Number(((totalApplied / totalSuggestions) * 100).toFixed(1))
        : 0,
      ...userKpi,
    },
  };
}

// ── 5. Engagement Depth Metrics ───────────────────────────────────────

/**
 * Compute engagement depth: for each user count how many distinct features
 * they used (completions, chat, agent, CLI, code review), then return
 * the distribution of feature counts and the average depth score.
 */
export function getEngagementDepthMetrics(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): EngagementDepthResult {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  const sql = `
    WITH user_features AS (
      SELECT
        user_login,
        (CASE WHEN MAX(code_generation_activity_count) > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_chat) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_agent) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_cli) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_copilot_code_review_active) = 1 THEN 1 ELSE 0 END)
        AS feature_count
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
      GROUP BY user_login
    )
    SELECT
      feature_count AS featureCount,
      COUNT(*) AS userCount
    FROM user_features
    GROUP BY feature_count
    ORDER BY feature_count ASC
  `;
  const rows = db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as Array<{
    featureCount: number;
    userCount: number;
  }>;

  let totalUsers = 0;
  let weightedSum = 0;
  // Ensure all buckets 1–5 are present
  const bucketMap = new Map<number, number>();
  for (let i = 1; i <= 5; i++) bucketMap.set(i, 0);
  for (const r of rows) {
    if (r.featureCount < 1) continue; // skip users with 0 features (no activity)
    bucketMap.set(r.featureCount, (bucketMap.get(r.featureCount) ?? 0) + r.userCount);
    totalUsers += r.userCount;
    weightedSum += r.featureCount * r.userCount;
  }

  const distribution = Array.from(bucketMap.entries()).map(([featureCount, userCount]) => ({
    featureCount,
    userCount,
  }));

  return {
    distribution,
    averageDepth: totalUsers > 0 ? Number((weightedSum / totalUsers).toFixed(2)) : 0,
    totalUsers,
  };
}

// ── 6. Time to Value Metrics ──────────────────────────────────────────

/**
 * For each user in copilot_seats, compute the number of days between
 * seat creation (created_at) and first activity day in user_daily_metrics.
 * Returns a bucketed distribution and average/median time-to-value.
 */
export function getTimeToValueMetrics(
  enterpriseSlugs?: string[],
): TimeToValueResult {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  const seatEf = ef.clause ? ef.clause.replace(" AND ", " WHERE ") : "";
  const sql = `
    WITH first_usage AS (
      SELECT user_login, MIN(day) AS first_day
      FROM user_daily_metrics
      WHERE 1=1 ${ef.clause}
      GROUP BY user_login
    ),
    seat_ttv AS (
      SELECT
        s.user_login,
        s.created_at,
        f.first_day,
        CASE
          WHEN f.first_day IS NOT NULL AND s.created_at IS NOT NULL
          THEN CAST(julianday(f.first_day) - julianday(date(s.created_at)) AS INTEGER)
          ELSE NULL
        END AS days_to_value
      FROM copilot_seats s
      LEFT JOIN first_usage f ON s.user_login = f.user_login
      ${seatEf}
    )
    SELECT days_to_value
    FROM seat_ttv
    WHERE days_to_value IS NOT NULL AND days_to_value >= 0
    ORDER BY days_to_value ASC
  `;
  const rows = db.prepare(sql).all(...ef.params, ...ef.params) as Array<{ days_to_value: number }>;

  if (rows.length === 0) {
    return { distribution: [], averageDays: 0, medianDays: 0, totalUsers: 0 };
  }

  // Build bucketed distribution
  const buckets: Record<string, number> = {
    "0": 0,
    "1": 0,
    "2-3": 0,
    "4-7": 0,
    "8-14": 0,
    "15-30": 0,
    "31+": 0,
  };
  let sum = 0;
  for (const r of rows) {
    const d = r.days_to_value;
    sum += d;
    if (d === 0) buckets["0"]++;
    else if (d === 1) buckets["1"]++;
    else if (d <= 3) buckets["2-3"]++;
    else if (d <= 7) buckets["4-7"]++;
    else if (d <= 14) buckets["8-14"]++;
    else if (d <= 30) buckets["15-30"]++;
    else buckets["31+"]++;
  }

  const distribution = Object.entries(buckets).map(([daysBucket, userCount]) => ({
    daysBucket,
    userCount,
  }));

  const medianIdx = Math.floor(rows.length / 2);

  return {
    distribution,
    averageDays: Number((sum / rows.length).toFixed(1)),
    medianDays: rows[medianIdx].days_to_value,
    totalUsers: rows.length,
  };
}

// ── 7. Adoption Funnel Metrics ────────────────────────────────────────

/**
 * Build an adoption funnel: total seats → active users → regular users
 * (5+ active days) → power users (3+ features).
 */
export function getAdoptionFunnelMetrics(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): AdoptionFunnelResult {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  // Total seats
  const seatEf = ef.clause ? ef.clause.replace(" AND ", " WHERE ") : "";
  const seatsSql = `SELECT COUNT(*) as cnt FROM copilot_seats ${seatEf}`;
  const seatRow = db.prepare(seatsSql).get(...ef.params) as { cnt: number };

  // User-level metrics
  const filter = buildLoginFilter(allowedLogins ?? []);
  const funnelSql = `
    WITH user_stats AS (
      SELECT
        user_login,
        COUNT(DISTINCT day) AS active_days,
        (CASE WHEN MAX(code_generation_activity_count) > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_chat) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_agent) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_cli) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_copilot_code_review_active) = 1 THEN 1 ELSE 0 END)
        AS feature_count
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
      GROUP BY user_login
    )
    SELECT
      COUNT(*) AS activeUsers,
      COUNT(CASE WHEN active_days >= 5 THEN 1 END) AS regularUsers,
      COUNT(CASE WHEN feature_count >= 3 THEN 1 END) AS powerUsers
    FROM user_stats
  `;
  const funnel = db.prepare(funnelSql).get(
    startDay, endDay, ...filter.params, ...ef.params,
  ) as { activeUsers: number; regularUsers: number; powerUsers: number };

  return {
    totalSeats: seatRow.cnt,
    ...funnel,
  };
}

// ── 8. Health Score Metrics ───────────────────────────────────────────

/**
 * Compute a composite health score from four dimensions:
 * adoption rate (30%), acceptance rate (25%), feature breadth (25%),
 * engagement frequency (20%).
 */
export function getHealthScoreMetrics(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): HealthScoreResult {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  // Total seats for adoption rate
  const seatEf = ef.clause ? ef.clause.replace(" AND ", " WHERE ") : "";
  const seatsSql = `SELECT COUNT(*) as cnt FROM copilot_seats ${seatEf}`;
  const seatRow = db.prepare(seatsSql).get(...ef.params) as { cnt: number };

  // Aggregated user stats
  const statsSql = `
    WITH user_stats AS (
      SELECT
        user_login,
        COUNT(DISTINCT day) AS active_days,
        COALESCE(SUM(code_generation_activity_count), 0) AS total_gen,
        COALESCE(SUM(code_acceptance_activity_count), 0) AS total_accept,
        (CASE WHEN MAX(code_generation_activity_count) > 0 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_chat) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_agent) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_cli) = 1 THEN 1 ELSE 0 END)
          + (CASE WHEN MAX(used_copilot_code_review_active) = 1 THEN 1 ELSE 0 END)
        AS feature_count
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
      GROUP BY user_login
    )
    SELECT
      COUNT(*) AS activeUsers,
      COALESCE(SUM(total_gen), 0) AS totalGen,
      COALESCE(SUM(total_accept), 0) AS totalAccept,
      COALESCE(AVG(feature_count), 0) AS avgFeatures,
      COALESCE(AVG(active_days), 0) AS avgActiveDays
    FROM user_stats
  `;
  const stats = db.prepare(statsSql).get(
    startDay, endDay, ...filter.params, ...ef.params,
  ) as {
    activeUsers: number;
    totalGen: number;
    totalAccept: number;
    avgFeatures: number;
    avgActiveDays: number;
  };

  // Compute number of days in range for frequency scaling
  const rangeStart = new Date(startDay);
  const rangeEnd = new Date(endDay);
  const rangeDays = Math.max(1, Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24)) + 1);

  // Adoption: active users / total seats (0-100)
  const adoptionRate = seatRow.cnt > 0
    ? Math.min(100, Number(((stats.activeUsers / seatRow.cnt) * 100).toFixed(1)))
    : 0;

  // Acceptance: total acceptances / total generations (0-100)
  const acceptanceRate = stats.totalGen > 0
    ? Math.min(100, Number(((stats.totalAccept / stats.totalGen) * 100).toFixed(1)))
    : 0;

  // Feature breadth: avg features per user scaled from 0-5 → 0-100
  const featureBreadth = Math.min(100, Number(((stats.avgFeatures / 5) * 100).toFixed(1)));

  // Engagement frequency: avg active days / range days (0-100)
  const engagementFrequency = Math.min(100, Number(((stats.avgActiveDays / rangeDays) * 100).toFixed(1)));

  // Weighted overall score
  const overallScore = Number(
    (adoptionRate * 0.3 + acceptanceRate * 0.25 + featureBreadth * 0.25 + engagementFrequency * 0.2).toFixed(1),
  );

  return {
    adoptionRate,
    acceptanceRate,
    featureBreadth,
    engagementFrequency,
    overallScore,
  };
}
