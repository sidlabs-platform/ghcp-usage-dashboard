import { getDb } from "./database";

export interface ChatModeSums {
  ask: number;
  edit: number;
  plan: number;
  agent: number;
  custom: number;
}

export interface AdoptionStats {
  totalUsers: number;
  agentUsers: number;
  codingAgentUsers: number;
  codeReviewUsers: number;
  cliUsers: number;
}

export interface UserSummary {
  login: string;
  activeDays: number;
  locAdded: number;
  locDeleted: number;
  interactions: number;
  codeGen: number;
  codeAccept: number;
  acceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReviewActive: boolean;
  usedCodeReviewPassive: boolean;
  usedCodingAgent: boolean;
}

function buildLoginFilter(allowedLogins: string[]): { clause: string; params: string[] } {
  if (allowedLogins.length === 0) return { clause: "", params: [] };
  const placeholders = allowedLogins.map(() => "?").join(",");
  return { clause: `AND user_login IN (${placeholders})`, params: allowedLogins };
}

export function getChatModeSums(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
): ChatModeSums {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const sql = `
    SELECT
      COALESCE(SUM(chat_panel_ask_mode), 0) as ask,
      COALESCE(SUM(chat_panel_edit_mode), 0) as edit,
      COALESCE(SUM(chat_panel_plan_mode), 0) as plan,
      COALESCE(SUM(chat_panel_agent_mode), 0) as agent,
      COALESCE(SUM(chat_panel_custom_mode), 0) as custom
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params) as ChatModeSums;
  return row;
}

export function getAdoptionStats(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
): AdoptionStats {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const sql = `
    SELECT
      COUNT(DISTINCT user_login) as totalUsers,
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_coding_agent = 1 THEN user_login END) as codingAgentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_active = 1 THEN user_login END) as codeReviewUsers,
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params) as AdoptionStats;
  return row;
}

export function getUserSummaries(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
): UserSummary[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const sql = `
    SELECT
      user_login as login,
      COUNT(DISTINCT day) as activeDays,
      COALESCE(SUM(loc_added_sum), 0) as locAdded,
      COALESCE(SUM(loc_deleted_sum), 0) as locDeleted,
      COALESCE(SUM(user_initiated_interaction_count), 0) as interactions,
      COALESCE(SUM(code_generation_activity_count), 0) as codeGen,
      COALESCE(SUM(code_acceptance_activity_count), 0) as codeAccept,
      MAX(used_agent) as usedAgent,
      MAX(used_chat) as usedChat,
      MAX(used_cli) as usedCli,
      MAX(used_copilot_code_review_active) as usedCodeReviewActive,
      MAX(used_copilot_code_review_passive) as usedCodeReviewPassive,
      MAX(used_copilot_coding_agent) as usedCodingAgent
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}
    GROUP BY user_login
  `;
  const rows = db.prepare(sql).all(startDay, endDay, ...filter.params) as Array<{
    login: string;
    activeDays: number;
    locAdded: number;
    locDeleted: number;
    interactions: number;
    codeGen: number;
    codeAccept: number;
    usedAgent: number;
    usedChat: number;
    usedCli: number;
    usedCodeReviewActive: number;
    usedCodeReviewPassive: number;
    usedCodingAgent: number;
  }>;

  return rows.map((r) => ({
    login: r.login,
    activeDays: r.activeDays,
    locAdded: r.locAdded,
    locDeleted: r.locDeleted,
    interactions: r.interactions,
    codeGen: r.codeGen,
    codeAccept: r.codeAccept,
    acceptanceRate: r.codeGen > 0 ? Number(((r.codeAccept / r.codeGen) * 100).toFixed(1)) : 0,
    usedAgent: r.usedAgent === 1,
    usedChat: r.usedChat === 1,
    usedCli: r.usedCli === 1,
    usedCodeReviewActive: r.usedCodeReviewActive === 1,
    usedCodeReviewPassive: r.usedCodeReviewPassive === 1,
    usedCodingAgent: r.usedCodingAgent === 1,
  }));
}
