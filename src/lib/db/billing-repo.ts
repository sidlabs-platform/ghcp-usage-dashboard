// Billing repository — CRUD for usage records, premium requests, aggregates, and sync state

import { getDb } from "./database";
import type {
  BillingUsageRecord,
  BillingPremiumRequestRecord,
  BillingDailyAggregate,
  BillingSyncState,
  BillingOverviewKPIs,
  BillingProductBreakdown,
  BillingOrgBreakdown,
  BillingUserBreakdown,
  BillingCostCenterBreakdown,
  BillingRepositoryBreakdown,
  BillingReportType,
  ChargeScope,
  PremiumRequestUserSummary,
  PremiumRequestModelSummary,
  PremiumUserModelBreakdown,
  PremiumDailyTrend,
  PremiumCostCenterBreakdown,
  PremiumOrgBreakdown,
  TokenKpis,
  TokenModelSummary,
  TokenDailyTrendPoint,
  TokenUserSummary,
  TokenAttribution,
  TokenAttributionRow,
  TokenModelDailyPoint,
} from "@/lib/types/billing";

const AI_CREDITS_START_DATE = "2026-06-01";

// ── Filter Interfaces ─────────────────────────────────────────────────

export interface BillingFilters {
  product?: string[];
  sku?: string[];
  organization?: string[];
  username?: string;
  chargeScope?: ChargeScope;
  costCenter?: string;
  /** Scope filter: resolved user logins from team/org selection */
  allowedLogins?: string[];
  /** Scope filter: selected organization slugs for org-level charges */
  scopeOrgs?: string[];
}

export interface PremiumFilters {
  username?: string;
  organization?: string[];
  model?: string[];
  exceedsQuota?: boolean;
  /** Scope filter: resolved user logins from team/org selection */
  allowedLogins?: string[];
  /** Scope filter: selected organization slugs for org-level charges */
  scopeOrgs?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────

function appendBillingFilters(
  clauses: string[],
  params: unknown[],
  filters?: BillingFilters
): void {
  if (!filters) return;
  if (filters.product?.length) {
    clauses.push(`product IN (${filters.product.map(() => "?").join(",")})`);
    params.push(...filters.product);
  }
  if (filters.sku?.length) {
    clauses.push(`sku IN (${filters.sku.map(() => "?").join(",")})`);
    params.push(...filters.sku);
  }
  // Organization filter: intersect with scopeOrgs when both are present
  if (filters.organization?.length && filters.scopeOrgs?.length) {
    const intersection = filters.organization.filter(o => filters.scopeOrgs!.includes(o));
    if (intersection.length === 0) {
      clauses.push("1 = 0");
      return;
    }
    clauses.push(
      `organization IN (${intersection.map(() => "?").join(",")})`
    );
    params.push(...intersection);
  } else if (filters.organization?.length) {
    clauses.push(
      `organization IN (${filters.organization.map(() => "?").join(",")})`
    );
    params.push(...filters.organization);
  }
  if (filters.username) {
    clauses.push(`username = ?`);
    params.push(filters.username);
  }
  if (filters.chargeScope) {
    clauses.push(`charge_scope = ?`);
    params.push(filters.chargeScope);
  }
  if (filters.costCenter) {
    clauses.push(`cost_center_name = ?`);
    params.push(filters.costCenter);
  }
  // Scope filter: team/org filtering via resolved logins + org slugs
  // Skip scopeOrgs in the OR clause if page-level org filter already intersected above
  const scopeOrgsHandled = filters.organization?.length && filters.scopeOrgs?.length;
  if (filters.allowedLogins !== undefined || (filters.scopeOrgs?.length && !scopeOrgsHandled)) {
    // Short-circuit: if scope is active but resolved to nothing, match nothing
    const hasLogins = filters.allowedLogins && filters.allowedLogins.length > 0;
    const hasOrgs = filters.scopeOrgs && filters.scopeOrgs.length > 0 && !scopeOrgsHandled;
    if (!hasLogins && !hasOrgs) {
      clauses.push("1 = 0");
      return;
    }
    const scopeParts: string[] = [];
    if (hasLogins) {
      scopeParts.push(
        `username IN (${filters.allowedLogins!.map(() => "?").join(",")})`
      );
      params.push(...filters.allowedLogins!);
    }
    if (hasOrgs) {
      scopeParts.push(
        `organization IN (${filters.scopeOrgs!.map(() => "?").join(",")})`
      );
      params.push(...filters.scopeOrgs!);
    }
    if (scopeParts.length > 0) {
      clauses.push(`(${scopeParts.join(" OR ")})`);
    }
  }
}

function appendPremiumFilters(
  clauses: string[],
  params: unknown[],
  filters?: PremiumFilters
): void {
  if (!filters) return;
  if (filters.username) {
    clauses.push(`username = ?`);
    params.push(filters.username);
  }
  // Organization filter: intersect with scopeOrgs when both are present
  if (filters.organization?.length && filters.scopeOrgs?.length) {
    const intersection = filters.organization.filter(o => filters.scopeOrgs!.includes(o));
    if (intersection.length === 0) {
      clauses.push("1 = 0");
      return;
    }
    clauses.push(
      `organization IN (${intersection.map(() => "?").join(",")})`
    );
    params.push(...intersection);
  } else if (filters.organization?.length) {
    clauses.push(
      `organization IN (${filters.organization.map(() => "?").join(",")})`
    );
    params.push(...filters.organization);
  }
  if (filters.model?.length) {
    clauses.push(`model IN (${filters.model.map(() => "?").join(",")})`);
    params.push(...filters.model);
  }
  if (filters.exceedsQuota !== undefined) {
    clauses.push(`exceeds_quota = ?`);
    params.push(filters.exceedsQuota ? "TRUE" : "FALSE");
  }
  // Scope filter: team/org filtering via resolved logins + org slugs
  const scopeOrgsHandled = filters.organization?.length && filters.scopeOrgs?.length;
  if (filters.allowedLogins !== undefined || (filters.scopeOrgs?.length && !scopeOrgsHandled)) {
    const hasLogins = filters.allowedLogins && filters.allowedLogins.length > 0;
    const hasOrgs = filters.scopeOrgs && filters.scopeOrgs.length > 0 && !scopeOrgsHandled;
    if (!hasLogins && !hasOrgs) {
      clauses.push("1 = 0");
      return;
    }
    const scopeParts: string[] = [];
    if (hasLogins) {
      scopeParts.push(
        `username IN (${filters.allowedLogins!.map(() => "?").join(",")})`
      );
      params.push(...filters.allowedLogins!);
    }
    if (hasOrgs) {
      scopeParts.push(
        `organization IN (${filters.scopeOrgs!.map(() => "?").join(",")})`
      );
      params.push(...filters.scopeOrgs!);
    }
    if (scopeParts.length > 0) {
      clauses.push(`(${scopeParts.join(" OR ")})`);
    }
  }
}

function buildWhereClause(clauses: string[]): string {
  return clauses.length ? " WHERE " + clauses.join(" AND ") : "";
}

function buildEnterpriseFilter(slugs?: string[]): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND enterprise_slug IN (${placeholders})`, params: slugs };
}

// ── Sort Column Whitelists────────────────────────────────────────────

const USAGE_SORT_COLUMNS = new Set([
  "date",
  "product",
  "sku",
  "quantity",
  "unit_type",
  "applied_cost_per_quantity",
  "gross_amount",
  "discount_amount",
  "net_amount",
  "organization",
  "repository",
  "username",
  "workflow_path",
  "cost_center_name",
  "charge_scope",
]);

const PREMIUM_SORT_COLUMNS = new Set([
  "date",
  "product",
  "sku",
  "quantity",
  "unit_type",
  "applied_cost_per_quantity",
  "gross_amount",
  "discount_amount",
  "net_amount",
  "username",
  "organization",
  "model",
  "exceeds_quota",
  "total_monthly_quota",
  "charge_scope",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_center_name",
  "aic_quantity",
  "aic_gross_amount",
  "repository",
]);

// ── Upsert Operations ────────────────────────────────────────────────

export function upsertUsageRecords(enterpriseSlug: string, records: BillingUsageRecord[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO billing_usage_records
      (enterprise_slug, date, product, sku, quantity, unit_type, applied_cost_per_quantity,
       gross_amount, discount_amount, net_amount, organization, repository,
       username, workflow_path, cost_center_name, charge_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of records) {
      stmt.run(
        enterpriseSlug,
        r.date,
        r.product,
        r.sku,
        r.quantity,
        r.unit_type,
        r.applied_cost_per_quantity,
        r.gross_amount,
        r.discount_amount,
        r.net_amount,
        r.organization,
        r.repository,
        r.username,
        r.workflow_path,
        r.cost_center_name,
        r.charge_scope
      );
    }
  });
  tx();
}

/**
 * Collapse records that share the storage dedup key by summing their additive
 * fields.
 *
 * The AI usage report can emit several rows with an identical
 * (date, sku, username, organization, repository, model) tuple — verified
 * against a live octodemo export. Because persistence uses INSERT OR REPLACE,
 * writing them one at a time would keep only the last row and silently discard
 * the rest. Summing first preserves the full quantity, cost and token totals.
 */
export function aggregatePremiumRecords(
  records: BillingPremiumRequestRecord[]
): BillingPremiumRequestRecord[] {
  const merged = new Map<string, BillingPremiumRequestRecord>();
  for (const r of records) {
    const key = [r.date, r.sku, r.username, r.organization, r.repository, r.model].join("\u0000");
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...r });
      continue;
    }
    prev.quantity += r.quantity;
    prev.gross_amount += r.gross_amount;
    prev.discount_amount += r.discount_amount;
    prev.net_amount += r.net_amount;
    prev.input_tokens += r.input_tokens;
    prev.output_tokens += r.output_tokens;
    prev.cached_tokens += r.cached_tokens;
    prev.cache_read_tokens += r.cache_read_tokens;
    prev.cache_write_tokens += r.cache_write_tokens;
    prev.aic_quantity += r.aic_quantity;
    prev.aic_gross_amount += r.aic_gross_amount;
    // Non-additive fields: keep the largest quota and prefer a populated value.
    prev.total_monthly_quota = Math.max(prev.total_monthly_quota, r.total_monthly_quota);
    if (!prev.cost_center_name) prev.cost_center_name = r.cost_center_name;
    if (!prev.product) prev.product = r.product;
    if (!prev.unit_type) prev.unit_type = r.unit_type;
    if (r.exceeds_quota === "TRUE") prev.exceeds_quota = "TRUE";
  }
  return [...merged.values()];
}

export function upsertPremiumRequests(
  enterpriseSlug: string,
  records: BillingPremiumRequestRecord[]
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO billing_premium_requests
      (enterprise_slug, date, product, sku, quantity, unit_type, applied_cost_per_quantity,
       gross_amount, discount_amount, net_amount, username, organization, repository,
       model, exceeds_quota, total_monthly_quota, charge_scope,
       input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_write_tokens,
       cost_center_name, aic_quantity, aic_gross_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Rows written before `repository` joined the dedup key were all stored with
  // repository = ''. Because INSERT OR REPLACE now matches on the wider key, a
  // refetched row carrying a real repository no longer replaces its legacy
  // twin — both would survive and double-count credits, tokens and dollars.
  //
  // Only delete a legacy row when the incoming batch has no genuinely
  // repository-less row for that same key, so SKUs that legitimately report an
  // empty repository are never touched.
  const legacyTwin = db.prepare(`
    DELETE FROM billing_premium_requests
     WHERE enterprise_slug = ? AND date = ? AND sku = ?
       AND COALESCE(username, '') = ? AND COALESCE(organization, '') = ?
       AND COALESCE(model, '') = ? AND COALESCE(repository, '') = ''
  `);
  const deduped = aggregatePremiumRecords(records);
  const narrowKey = (r: BillingPremiumRequestRecord) =>
    [r.date, r.sku, r.username ?? "", r.organization ?? "", r.model ?? ""].join("\u0000");
  const keysWithEmptyRepo = new Set(
    deduped.filter((r) => !r.repository).map(narrowKey)
  );
  const keysNeedingCleanup = new Map<string, BillingPremiumRequestRecord>();
  for (const r of deduped) {
    if (!r.repository) continue;
    const key = narrowKey(r);
    if (keysWithEmptyRepo.has(key)) continue;
    if (!keysNeedingCleanup.has(key)) keysNeedingCleanup.set(key, r);
  }

  const tx = db.transaction(() => {
    for (const r of keysNeedingCleanup.values()) {
      legacyTwin.run(
        enterpriseSlug,
        r.date,
        r.sku,
        r.username ?? "",
        r.organization ?? "",
        r.model ?? ""
      );
    }
    for (const r of deduped) {
      stmt.run(
        enterpriseSlug,
        r.date,
        r.product,
        r.sku,
        r.quantity,
        r.unit_type,
        r.applied_cost_per_quantity,
        r.gross_amount,
        r.discount_amount,
        r.net_amount,
        r.username,
        r.organization,
        r.repository ?? "",
        r.model,
        r.exceeds_quota,
        r.total_monthly_quota,
        r.charge_scope,
        r.input_tokens,
        r.output_tokens,
        r.cached_tokens,
        r.cache_read_tokens ?? 0,
        r.cache_write_tokens ?? 0,
        r.cost_center_name,
        r.aic_quantity,
        r.aic_gross_amount
      );
    }
  });
  tx();
}

// ── Query Operations ──────────────────────────────────────────────────

export function getOverviewKPIs(
  start: string,
  end: string,
  filters?: BillingFilters,
  enterpriseSlugs?: string[]
): BillingOverviewKPIs {
  const db = getDb();

  // Metered usage totals
  const usageClauses: string[] = ["date >= ?", "date <= ?"];
  const usageParams: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { usageClauses.push(entClause.replace(/^\s*AND\s+/, "")); usageParams.push(...entParams); }
  appendBillingFilters(usageClauses, usageParams, filters);

  const usage = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(net_amount), 0)       AS totalNet,
      COALESCE(SUM(gross_amount), 0)     AS totalGross,
      COALESCE(SUM(discount_amount), 0)  AS totalDiscount,
      COUNT(DISTINCT product)            AS uniqueProducts,
      COUNT(DISTINCT CASE WHEN organization != '' THEN organization END) AS uniqueOrgs,
      COALESCE(SUM(CASE WHEN charge_scope = 'user' THEN net_amount ELSE 0 END), 0) AS userChargesNet,
      COALESCE(SUM(CASE WHEN charge_scope = 'org'  THEN net_amount ELSE 0 END), 0) AS orgChargesNet
    FROM billing_usage_records
    ${buildWhereClause(usageClauses)}
  `
    )
    .get(...usageParams) as BillingOverviewKPIs;

  // Premium request totals (always user-level)
  const premClauses: string[] = ["date >= ?", "date <= ?"];
  const premParams: unknown[] = [start, end];
  if (entClause) { premClauses.push(entClause.replace(/^\s*AND\s+/, "")); premParams.push(...entParams); }
  // Apply only scope filters to premium
  if (filters?.allowedLogins?.length || filters?.scopeOrgs?.length) {
    appendPremiumFilters(premClauses, premParams, {
      allowedLogins: filters.allowedLogins,
      scopeOrgs: filters.scopeOrgs,
    });
  }

  const premium = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(net_amount), 0)       AS premNet,
      COALESCE(SUM(gross_amount), 0)     AS premGross,
      COALESCE(SUM(discount_amount), 0)  AS premDiscount
    FROM billing_premium_requests
    ${buildWhereClause(premClauses)}
  `
    )
    .get(...premParams) as { premNet: number; premGross: number; premDiscount: number } | undefined;

  const pn = premium?.premNet ?? 0;
  const pg = premium?.premGross ?? 0;
  const pd = premium?.premDiscount ?? 0;

  return {
    totalNet: (usage?.totalNet ?? 0) + pn,
    totalGross: (usage?.totalGross ?? 0) + pg,
    totalDiscount: (usage?.totalDiscount ?? 0) + pd,
    uniqueProducts: usage?.uniqueProducts ?? 0,
    uniqueOrgs: usage?.uniqueOrgs ?? 0,
    userChargesNet: (usage?.userChargesNet ?? 0) + pn,
    orgChargesNet: usage?.orgChargesNet ?? 0,
  };
}

export function getDailyAggregates(
  start: string,
  end: string,
  filters?: BillingFilters,
  enterpriseSlugs?: string[]
): BillingDailyAggregate[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendBillingFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      date AS day,
      product,
      charge_scope,
      COALESCE(SUM(quantity), 0)         AS total_quantity,
      COALESCE(SUM(gross_amount), 0)     AS total_gross,
      COALESCE(SUM(discount_amount), 0)  AS total_discount,
      COALESCE(SUM(net_amount), 0)       AS total_net,
      COUNT(*)                           AS record_count
    FROM billing_usage_records
    ${buildWhereClause(clauses)}
    GROUP BY date, product, charge_scope
    ORDER BY date
  `
    )
    .all(...params) as BillingDailyAggregate[];
}

export function getProductBreakdown(
  start: string,
  end: string,
  filters?: BillingFilters,
  enterpriseSlugs?: string[]
): BillingProductBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendBillingFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      product,
      charge_scope,
      COALESCE(SUM(quantity), 0)         AS total_quantity,
      COALESCE(SUM(gross_amount), 0)     AS total_gross,
      COALESCE(SUM(discount_amount), 0)  AS total_discount,
      COALESCE(SUM(net_amount), 0)       AS total_net
    FROM billing_usage_records
    ${buildWhereClause(clauses)}
    GROUP BY product, charge_scope
    ORDER BY total_net DESC
  `
    )
    .all(...params) as BillingProductBreakdown[];
}

export function getOrgBreakdown(
  start: string,
  end: string,
  filters?: BillingFilters,
  enterpriseSlugs?: string[]
): BillingOrgBreakdown[] {
  const db = getDb();
  const clauses: string[] = [
    "date >= ?",
    "date <= ?",
    "organization != ''",
  ];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendBillingFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      organization,
      COALESCE(SUM(gross_amount), 0)     AS total_gross,
      COALESCE(SUM(discount_amount), 0)  AS total_discount,
      COALESCE(SUM(net_amount), 0)       AS total_net
    FROM billing_usage_records
    ${buildWhereClause(clauses)}
    GROUP BY organization
    ORDER BY total_net DESC
  `
    )
    .all(...params) as BillingOrgBreakdown[];
}

export function getUserBreakdown(
  start: string,
  end: string,
  filters?: BillingFilters,
  enterpriseSlugs?: string[]
): BillingUserBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", "username != ''"];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendBillingFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      username,
      organization,
      COALESCE(SUM(gross_amount), 0)     AS total_gross,
      COALESCE(SUM(discount_amount), 0)  AS total_discount,
      COALESCE(SUM(net_amount), 0)       AS total_net
    FROM billing_usage_records
    ${buildWhereClause(clauses)}
    GROUP BY username, organization
    ORDER BY total_net DESC
  `
    )
    .all(...params) as BillingUserBreakdown[];
}

// ── Paginated Queries ─────────────────────────────────────────────────

export function getUsageRecordsPaginated(
  start: string,
  end: string,
  page: number,
  pageSize: number,
  sort: string,
  sortDir: "asc" | "desc",
  search?: string,
  filters?: BillingFilters,
  enterpriseSlugs?: string[]
): { records: BillingUsageRecord[]; total: number } {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendBillingFilters(clauses, params, filters);

  if (search) {
    clauses.push(
      `(product LIKE ? OR sku LIKE ? OR organization LIKE ? OR username LIKE ?)`
    );
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = buildWhereClause(clauses);
  const safeSort = USAGE_SORT_COLUMNS.has(sort) ? sort : "date";
  const safeDir = sortDir === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM billing_usage_records${where}`)
      .get(...params) as { cnt: number }
  ).cnt;

  const records = db
    .prepare(
      `
    SELECT date, product, sku, quantity, unit_type, applied_cost_per_quantity,
           gross_amount, discount_amount, net_amount, organization, repository,
           username, workflow_path, cost_center_name, charge_scope
    FROM billing_usage_records
    ${where}
    ORDER BY ${safeSort} ${safeDir}
    LIMIT ? OFFSET ?
  `
    )
    .all(...params, pageSize, offset) as BillingUsageRecord[];

  return { records, total };
}

export function getPremiumRequestsPaginated(
  start: string,
  end: string,
  page: number,
  pageSize: number,
  sort: string,
  sortDir: "asc" | "desc",
  search?: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): { records: BillingPremiumRequestRecord[]; total: number } {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendPremiumFilters(clauses, params, filters);

  if (search) {
    clauses.push(
      `(product LIKE ? OR sku LIKE ? OR username LIKE ? OR organization LIKE ? OR model LIKE ?)`
    );
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const where = buildWhereClause(clauses);
  const safeSort = PREMIUM_SORT_COLUMNS.has(sort) ? sort : "date";
  const safeDir = sortDir === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS cnt FROM billing_premium_requests${where}`)
      .get(...params) as { cnt: number }
  ).cnt;

  const records = db
    .prepare(
      `
    SELECT date, product, sku, quantity, unit_type, applied_cost_per_quantity,
           gross_amount, discount_amount, net_amount, username, organization,
           COALESCE(repository, '') AS repository,
           model, exceeds_quota, total_monthly_quota, charge_scope,
           COALESCE(input_tokens, 0) AS input_tokens,
           COALESCE(output_tokens, 0) AS output_tokens,
           COALESCE(cached_tokens, 0) AS cached_tokens,
           COALESCE(cost_center_name, '') AS cost_center_name,
           COALESCE(aic_quantity, 0) AS aic_quantity,
           COALESCE(aic_gross_amount, 0) AS aic_gross_amount
    FROM billing_premium_requests
    ${where}
    ORDER BY ${safeSort} ${safeDir}
    LIMIT ? OFFSET ?
  `
    )
    .all(...params, pageSize, offset) as BillingPremiumRequestRecord[];

  return { records, total };
}

// ── Premium Request Summaries ─────────────────────────────────────────

export function getPremiumUserSummary(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): PremiumRequestUserSummary[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      username,
      organization,
      COALESCE(SUM(aic_quantity), 0)  AS total_requests,
      COALESCE(SUM(CASE WHEN exceeds_quota = 'FALSE' THEN aic_quantity ELSE 0 END), 0) AS within_quota,
      COALESCE(SUM(CASE WHEN exceeds_quota = 'TRUE'  THEN aic_quantity ELSE 0 END), 0) AS over_quota,
      COALESCE(MAX(total_monthly_quota), 0) AS quota_limit,
      CASE
        WHEN MAX(total_monthly_quota) > 0
        THEN ROUND(COALESCE(SUM(aic_quantity), 0) * 100.0 / MAX(total_monthly_quota), 2)
        ELSE 0
      END AS utilization_pct,
      COALESCE(SUM(aic_gross_amount), 0) AS total_net,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
      COALESCE(SUM(cache_read_tokens), 0)  AS total_cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
      COALESCE(SUM(aic_quantity), 0)   AS total_aic_quantity,
      COALESCE(SUM(aic_gross_amount), 0) AS total_aic_gross
    FROM billing_premium_requests
    ${buildWhereClause(clauses)}
    GROUP BY username, organization
    ORDER BY total_requests DESC
  `
    )
    .all(...params) as PremiumRequestUserSummary[];
}

export function getPremiumModelSummary(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): PremiumRequestModelSummary[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      model,
      COALESCE(SUM(aic_quantity), 0) AS total_requests,
      COALESCE(SUM(aic_gross_amount), 0) AS total_net,
      COUNT(DISTINCT username)           AS unique_users,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
      COALESCE(SUM(cache_read_tokens), 0)  AS total_cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
      COALESCE(SUM(aic_quantity), 0)   AS total_aic_quantity,
      COALESCE(SUM(aic_gross_amount), 0) AS total_aic_gross
    FROM billing_premium_requests
    ${buildWhereClause(clauses)}
    GROUP BY model
    ORDER BY total_requests DESC
  `
    )
    .all(...params) as PremiumRequestModelSummary[];
}

/**
 * Returns per-model AI credits and USD totals for a specific user over a date range.
 * @param start - Start date (ISO format)
 * @param end - End date (ISO format)
 * @param username - The user's login to query
 * @param organization - Optional organization filter (empty string matches unassigned users)
 * @param filters - Optional premium filters (model, exceedsQuota, scope)
 * @param enterpriseSlugs - Optional enterprise slug filter
 * @returns Array of model breakdowns with ai_credits and usd totals
 */
export function getPremiumUserModelBreakdown(
  start: string,
  end: string,
  username: string,
  organization?: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): PremiumUserModelBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", "username = ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end, username];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }

  if (organization !== undefined) {
    if (organization === "") {
      clauses.push(`COALESCE(organization, '') = ''`);
    } else {
      clauses.push(`organization = ?`);
      params.push(organization);
    }
  }

  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      model,
      COALESCE(SUM(aic_quantity), 0) AS ai_credits,
      COALESCE(SUM(aic_gross_amount), 0) AS usd
    FROM billing_premium_requests
    ${buildWhereClause(clauses)}
    GROUP BY model
    HAVING COALESCE(SUM(aic_quantity), 0) > 0
      OR COALESCE(SUM(aic_gross_amount), 0) > 0
    ORDER BY ai_credits DESC, usd DESC
  `
    )
    .all(...params) as PremiumUserModelBreakdown[];
}

// ── Cost Center / Repository / Premium Daily Breakdowns ───────────────

/**
 * Returns AI Credit consumption grouped by cost center over a date range,
 * sourced from the `billing_premium_requests` table (the ai_credit report is a
 * superset of premium_request). Uses `aic_quantity` for the credit total and
 * `aic_gross_amount` for the billed cost.
 *
 * Rows with no cost center assigned are retained with an empty `cost_center_name`
 * so the caller can surface an explicit "Unattributed" bucket rather than
 * dropping org-less / cost-center-less usage.
 *
 * @param start - Inclusive start date (ISO `YYYY-MM-DD`).
 * @param end - Inclusive end date (ISO `YYYY-MM-DD`).
 * @param filters - Optional premium filters (model, org, exceedsQuota, scope).
 * @param enterpriseSlugs - Optional enterprise slug allow-list.
 * @returns Cost-center breakdown rows sorted by AI credits then cost, descending.
 */
export function getPremiumCostCenterBreakdown(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): PremiumCostCenterBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      COALESCE(cost_center_name, '')     AS cost_center_name,
      COALESCE(SUM(aic_quantity), 0)     AS total_aic_quantity,
      COALESCE(SUM(aic_gross_amount), 0) AS total_aic_gross,
      COUNT(DISTINCT username)           AS unique_users,
      COUNT(*)                           AS record_count
    FROM billing_premium_requests
    ${buildWhereClause(clauses)}
    GROUP BY COALESCE(cost_center_name, '')
    ORDER BY total_aic_quantity DESC, total_aic_gross DESC, cost_center_name ASC
  `
    )
    .all(...params) as PremiumCostCenterBreakdown[];
}

/**
 * Returns AI Credit consumption grouped by organization over a date range,
 * sourced from the `billing_premium_requests` table. Uses `aic_quantity` for
 * the credit total and `aic_gross_amount` for the billed cost.
 *
 * Org-less rows (empty `organization`) are intentionally NOT filtered out — the
 * 2026-07-02 metrics accuracy update now attributes AI-credit usage that is not
 * linked to an organization, and this breakdown keeps that usage visible as an
 * explicit "No organization / unattributed" bucket instead of dropping it.
 *
 * @param start - Inclusive start date (ISO `YYYY-MM-DD`).
 * @param end - Inclusive end date (ISO `YYYY-MM-DD`).
 * @param filters - Optional premium filters (model, org, exceedsQuota, scope).
 * @param enterpriseSlugs - Optional enterprise slug allow-list.
 * @returns Organization breakdown rows sorted by AI credits then cost, descending.
 */
export function getPremiumOrgBreakdown(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): PremiumOrgBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      COALESCE(organization, '')         AS organization,
      COALESCE(SUM(aic_quantity), 0)     AS total_aic_quantity,
      COALESCE(SUM(aic_gross_amount), 0) AS total_aic_gross,
      COUNT(DISTINCT username)           AS unique_users,
      COUNT(*)                           AS record_count
    FROM billing_premium_requests
    ${buildWhereClause(clauses)}
    GROUP BY COALESCE(organization, '')
    ORDER BY total_aic_quantity DESC, total_aic_gross DESC, organization ASC
  `
    )
    .all(...params) as PremiumOrgBreakdown[];
}

export function getCostCenterBreakdown(
  start: string,
  end: string,
  filters?: BillingFilters,
  enterpriseSlugs?: string[]
): BillingCostCenterBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", "cost_center_name != ''"];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendBillingFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      cost_center_name,
      COALESCE(SUM(gross_amount), 0)     AS total_gross,
      COALESCE(SUM(discount_amount), 0)  AS total_discount,
      COALESCE(SUM(net_amount), 0)       AS total_net,
      COUNT(*)                           AS record_count
    FROM billing_usage_records
    ${buildWhereClause(clauses)}
    GROUP BY cost_center_name
    ORDER BY total_net DESC
  `
    )
    .all(...params) as BillingCostCenterBreakdown[];
}

export function getRepositoryBreakdown(
  start: string,
  end: string,
  filters?: BillingFilters,
  limit: number = 20,
  enterpriseSlugs?: string[]
): BillingRepositoryBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", "repository != ''"];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendBillingFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      repository,
      organization,
      COALESCE(SUM(gross_amount), 0)     AS total_gross,
      COALESCE(SUM(discount_amount), 0)  AS total_discount,
      COALESCE(SUM(net_amount), 0)       AS total_net
    FROM billing_usage_records
    ${buildWhereClause(clauses)}
    GROUP BY repository, organization
    ORDER BY total_net DESC
    LIMIT ?
  `
    )
    .all(...params, limit) as BillingRepositoryBreakdown[];
}

export function getPremiumDailyTrend(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): PremiumDailyTrend[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) { clauses.push(entClause.replace(/^\s*AND\s+/, "")); params.push(...entParams); }
  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      date AS day,
      COALESCE(SUM(aic_quantity), 0) AS total_requests,
      COALESCE(SUM(aic_gross_amount), 0) AS total_net,
      COUNT(DISTINCT username)     AS unique_users,
      COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
      COALESCE(SUM(cache_read_tokens), 0)  AS total_cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
      COALESCE(SUM(aic_quantity), 0)   AS total_aic_quantity,
      COALESCE(SUM(aic_gross_amount), 0) AS total_aic_gross
    FROM billing_premium_requests
    ${buildWhereClause(clauses)}
    GROUP BY date
    ORDER BY date
  `
    )
    .all(...params) as PremiumDailyTrend[];
}

// ── Aggregate Operations ──────────────────────────────────────────────

export function refreshBillingDailyAggregates(enterpriseSlug?: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    if (enterpriseSlug !== undefined) {
      db.prepare(`DELETE FROM billing_daily_aggregate WHERE enterprise_slug = ?`).run(enterpriseSlug);
    } else {
      db.prepare(`DELETE FROM billing_daily_aggregate`).run();
    }
    const whereClause = enterpriseSlug !== undefined ? `WHERE enterprise_slug = ?` : "";
    const whereParams = enterpriseSlug !== undefined ? [enterpriseSlug] : [];
    db.prepare(
      `
      INSERT INTO billing_daily_aggregate
        (enterprise_slug, day, product, charge_scope, total_quantity, total_gross, total_discount, total_net, record_count)
      SELECT
        enterprise_slug,
        date,
        product,
        charge_scope,
        COALESCE(SUM(quantity), 0),
        COALESCE(SUM(gross_amount), 0),
        COALESCE(SUM(discount_amount), 0),
        COALESCE(SUM(net_amount), 0),
        COUNT(*)
      FROM billing_usage_records
      ${whereClause}
      GROUP BY enterprise_slug, date, product, charge_scope
    `
    ).run(...whereParams);
  });
  tx();
}

// ── Sync State ────────────────────────────────────────────────────────

export function getBillingSyncState(
  reportType: BillingReportType,
  enterpriseSlug?: string
): BillingSyncState | null {
  const db = getDb();
  const slug = enterpriseSlug ?? "";
  const row = db
    .prepare(
      `SELECT report_type, last_synced_at, last_report_start, last_report_end, status, error_message
       FROM billing_sync_state WHERE report_type = ? AND enterprise_slug = ?`
    )
    .get(reportType, slug) as BillingSyncState | undefined;
  return row ?? null;
}

export function updateBillingSyncState(
  reportType: BillingReportType,
  lastSyncedAt: string,
  lastReportStart: string,
  lastReportEnd: string,
  status: string,
  errorMessage?: string,
  enterpriseSlug?: string
): void {
  const db = getDb();
  const slug = enterpriseSlug ?? "";
  db.prepare(
    `
    INSERT INTO billing_sync_state
      (enterprise_slug, report_type, last_synced_at, last_report_start, last_report_end, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(enterprise_slug, report_type) DO UPDATE SET
      last_synced_at   = excluded.last_synced_at,
      last_report_start = excluded.last_report_start,
      last_report_end   = excluded.last_report_end,
      status            = excluded.status,
      error_message     = excluded.error_message
  `
  ).run(
    slug,
    reportType,
    lastSyncedAt,
    lastReportStart,
    lastReportEnd,
    status,
    errorMessage ?? null
  );
}

/**
 * Clear the stored sync state for the given billing report types so the next
 * sync refetches their full rolling window from scratch.
 *
 * Used by the opt-in token backfill: incremental sync only pulls days after
 * `last_report_end`, so days synced before the per-model token breakdown
 * existed would otherwise keep their zeroed token columns forever. Deleting
 * only the sync-state row is non-destructive — the usage rows themselves are
 * left in place and get overwritten by the refetch.
 */
export function resetBillingSyncState(
  reportTypes: BillingReportType[],
  enterpriseSlug?: string
): number {
  if (reportTypes.length === 0) return 0;
  const db = getDb();
  const placeholders = reportTypes.map(() => "?").join(",");
  const stmt =
    enterpriseSlug !== undefined
      ? db.prepare(
          `DELETE FROM billing_sync_state WHERE report_type IN (${placeholders}) AND enterprise_slug = ?`
        )
      : db.prepare(`DELETE FROM billing_sync_state WHERE report_type IN (${placeholders})`);
  const result =
    enterpriseSlug !== undefined
      ? stmt.run(...reportTypes, enterpriseSlug)
      : stmt.run(...reportTypes);
  return Number(result.changes ?? 0);
}

// ── Filter Options ────────────────────────────────────────────────────
export function getUsageFilterOptions(
  start: string,
  end: string,
  enterpriseSlugs?: string[]
): {
  products: string[];
  skus: string[];
  organizations: string[];
  costCenters: string[];
} {
  const db = getDb();
  const entFilter = buildEnterpriseFilter(enterpriseSlugs);
  const where = `WHERE date >= ? AND date <= ?${entFilter.clause}`;
  const params = [start, end, ...entFilter.params];

  const products = (
    db
      .prepare(
        `SELECT DISTINCT product FROM billing_usage_records ${where} ORDER BY product`
      )
      .all(...params) as { product: string }[]
  ).map((r) => r.product);

  const skus = (
    db
      .prepare(
        `SELECT DISTINCT sku FROM billing_usage_records ${where} ORDER BY sku`
      )
      .all(...params) as { sku: string }[]
  ).map((r) => r.sku);

  const organizations = (
    db
      .prepare(
        `SELECT DISTINCT organization FROM billing_usage_records ${where} AND organization != '' ORDER BY organization`
      )
      .all(...params) as { organization: string }[]
  ).map((r) => r.organization);

  const costCenters = (
    db
      .prepare(
        `SELECT DISTINCT cost_center_name FROM billing_usage_records ${where} AND cost_center_name != '' ORDER BY cost_center_name`
      )
      .all(...params) as { cost_center_name: string }[]
  ).map((r) => r.cost_center_name);

  return { products, skus, organizations, costCenters };
}

export function getPremiumFilterOptions(
  start: string,
  end: string,
  enterpriseSlugs?: string[]
): {
  models: string[];
  organizations: string[];
  users: string[];
} {
  const db = getDb();
  const entFilter = buildEnterpriseFilter(enterpriseSlugs);
  const where = `WHERE date >= ? AND date <= ? AND date >= '${AI_CREDITS_START_DATE}'${entFilter.clause}`;
  const params = [start, end, ...entFilter.params];

  const models = (
    db
      .prepare(
        `SELECT DISTINCT model FROM billing_premium_requests ${where} AND model != '' ORDER BY model`
      )
      .all(...params) as { model: string }[]
  ).map((r) => r.model);

  const organizations = (
    db
      .prepare(
        `SELECT DISTINCT organization FROM billing_premium_requests ${where} AND organization != '' ORDER BY organization`
      )
      .all(...params) as { organization: string }[]
  ).map((r) => r.organization);

  const users = (
    db
      .prepare(
        `SELECT DISTINCT username FROM billing_premium_requests ${where} AND username != '' ORDER BY username`
      )
      .all(...params) as { username: string }[]
  ).map((r) => r.username);

  return { models, organizations, users };
}

// ══════════════════════════════════════════════════════════════════════
// Token Usage Analytics
// ══════════════════════════════════════════════════════════════════════
//
// Backed by the per-model token breakdown GitHub added to the AI usage report
// on 2026-08-11 (`input`, `output`, `cache_read`, `cache_write` columns).
//
// Pool vs. additional credits
// ---------------------------
// The `ai_credit` report no longer emits `exceeds_quota`, so the split between
// allowance-covered ("pool") and billable ("additional") usage is derived from
// the billing amounts that every row carries:
//
//   discount_amount → covered by the account's included allowance  → pool
//   net_amount      → billable remainder                          → additional
//
// USD splits directly. Credits are apportioned by the discount/gross ratio,
// because credits are a *count* while the amounts are USD — the two must never
// be summed together. Rows with gross_amount = 0 cannot be apportioned and are
// treated as fully pool-covered (they carry no billable amount by definition).
//
// Legacy `premium_request` rows still carry an explicit `exceeds_quota` flag;
// when present it takes precedence over the amount ratio.

/** Fraction of a row's credits covered by the included allowance. */
const POOL_FRACTION_SQL = `
  CASE
    WHEN exceeds_quota = 'TRUE'  THEN 0.0
    WHEN exceeds_quota = 'FALSE' THEN 1.0
    WHEN gross_amount > 0        THEN MIN(1.0, MAX(0.0, discount_amount / gross_amount))
    ELSE 1.0
  END`;

const POOL_CREDITS_SQL = `COALESCE(SUM(aic_quantity * (${POOL_FRACTION_SQL})), 0)`;
const PAID_CREDITS_SQL = `COALESCE(SUM(aic_quantity * (1.0 - (${POOL_FRACTION_SQL}))), 0)`;

/** Column list shared by every token rollup. */
const TOKEN_SUMS_SQL = `
  COALESCE(SUM(input_tokens), 0)        AS input_tokens,
  COALESCE(SUM(output_tokens), 0)       AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0)  AS cache_write_tokens,
  COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
  COALESCE(SUM(aic_quantity), 0)        AS total_credits,
  ${POOL_CREDITS_SQL}                   AS pool_credits,
  ${PAID_CREDITS_SQL}                   AS paid_credits,
  COALESCE(SUM(aic_gross_amount), 0)    AS total_gross_usd`;

/**
 * Build the shared WHERE clause for token queries.
 * Mirrors the premium-request filter conventions (scope, org, model, enterprise).
 */
function buildTokenQuery(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): { where: string; params: unknown[] } {
  const clauses: string[] = ["date >= ?", "date <= ?", `date >= '${AI_CREDITS_START_DATE}'`];
  const params: unknown[] = [start, end];
  const { clause: entClause, params: entParams } = buildEnterpriseFilter(enterpriseSlugs);
  if (entClause) {
    clauses.push(entClause.replace(/^\s*AND\s+/, ""));
    params.push(...entParams);
  }
  appendPremiumFilters(clauses, params, filters);
  return { where: buildWhereClause(clauses), params };
}

function safeDiv(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

const MILLION = 1_000_000;

/**
 * Headline token KPIs for a date range, including the pool vs. additional split.
 */
export function getTokenKpis(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): TokenKpis {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);
  const row = db
    .prepare(
      `
    SELECT
      ${TOKEN_SUMS_SQL},
      COALESCE(SUM(discount_amount), 0) AS pool_usd,
      COALESCE(SUM(net_amount), 0)      AS paid_usd,
      COUNT(DISTINCT username)          AS unique_users,
      COUNT(DISTINCT model)             AS unique_models,
      COUNT(*)                          AS record_count
    FROM billing_premium_requests
    ${where}
  `
    )
    .get(...params) as TokenKpis | undefined;

  return (
    row ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      total_credits: 0,
      pool_credits: 0,
      paid_credits: 0,
      total_gross_usd: 0,
      pool_usd: 0,
      paid_usd: 0,
      unique_users: 0,
      unique_models: 0,
      record_count: 0,
    }
  );
}

/**
 * Per-model token totals with derived efficiency metrics
 * (credits per 1M tokens, USD per 1M tokens, output:input ratio, cache hit rate).
 */
export function getTokenModelSummary(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): TokenModelSummary[] {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);
  const rows = db
    .prepare(
      `
    SELECT
      model,
      ${TOKEN_SUMS_SQL},
      COALESCE(SUM(discount_amount), 0) AS pool_usd,
      COALESCE(SUM(net_amount), 0)      AS paid_usd,
      COUNT(DISTINCT username)          AS unique_users,
      COUNT(*)                          AS record_count
    FROM billing_premium_requests
    ${where}
    GROUP BY model
    ORDER BY total_credits DESC, model ASC
  `
    )
    .all(...params) as Omit<
    TokenModelSummary,
    "credits_per_mtok" | "usd_per_mtok" | "output_input_ratio" | "cache_hit_rate"
  >[];

  return rows.map((r) => ({
    ...r,
    credits_per_mtok: safeDiv(r.total_credits * MILLION, r.total_tokens),
    usd_per_mtok: safeDiv(r.total_gross_usd * MILLION, r.total_tokens),
    output_input_ratio: safeDiv(r.output_tokens, r.input_tokens),
    cache_hit_rate: safeDiv(r.cache_read_tokens * 100, r.input_tokens + r.cache_read_tokens),
  }));
}

/**
 * Daily token totals for the stacked trend chart.
 */
export function getTokenDailyTrend(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): TokenDailyTrendPoint[] {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);
  return db
    .prepare(
      `
    SELECT
      date AS day,
      ${TOKEN_SUMS_SQL},
      COUNT(DISTINCT username) AS unique_users
    FROM billing_premium_requests
    ${where}
    GROUP BY date
    ORDER BY date ASC
  `
    )
    .all(...params) as TokenDailyTrendPoint[];
}

/**
 * Top token consumers, with each user's pool vs. additional credit split.
 */
export function getTokenUserSummary(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[],
  limit = 100
): TokenUserSummary[] {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);
  const rows = db
    .prepare(
      `
    SELECT
      username,
      organization,
      ${TOKEN_SUMS_SQL},
      COALESCE(SUM(discount_amount), 0) AS pool_usd,
      COALESCE(SUM(net_amount), 0)      AS paid_usd,
      COUNT(DISTINCT model)             AS unique_models
    FROM billing_premium_requests
    ${where}
    GROUP BY username, organization
    ORDER BY total_tokens DESC, username ASC
    LIMIT ?
  `
    )
    .all(...params, limit) as Omit<TokenUserSummary, "credits_per_mtok" | "cache_hit_rate">[];

  return rows.map((r) => ({
    ...r,
    credits_per_mtok: safeDiv(r.total_credits * MILLION, r.total_tokens),
    cache_hit_rate: safeDiv(r.cache_read_tokens * 100, r.input_tokens + r.cache_read_tokens),
  }));
}

/**
 * Token and cost attribution grouped by organization, cost center and repository.
 *
 * Empty keys are preserved rather than dropped — the UI surfaces them as an
 * explicit "Unattributed" bucket, matching `getPremiumOrgBreakdown` behaviour.
 */
export function getTokenAttribution(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[],
  limit = 50
): TokenAttribution {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);

  const query = (column: string): TokenAttributionRow[] =>
    db
      .prepare(
        `
    SELECT
      ${column} AS key,
      ${TOKEN_SUMS_SQL},
      COUNT(DISTINCT username) AS unique_users,
      COUNT(*)                 AS record_count
    FROM billing_premium_requests
    ${where}
    GROUP BY ${column}
    ORDER BY total_credits DESC, key ASC
    LIMIT ?
  `
      )
      .all(...params, limit) as TokenAttributionRow[];

  return {
    byOrganization: query("organization"),
    byCostCenter: query("cost_center_name"),
    byRepository: query("repository"),
  };
}

/**
 * Per-model, per-day observations feeding correlation and anomaly analysis.
 * Aggregated in SQL so only a small matrix reaches JS.
 */
export function getTokenModelDailySeries(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): TokenModelDailyPoint[] {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);
  return db
    .prepare(
      `
    SELECT
      date AS day,
      model,
      COALESCE(SUM(input_tokens), 0)       AS input_tokens,
      COALESCE(SUM(output_tokens), 0)      AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
      COALESCE(SUM(aic_quantity), 0)       AS total_credits,
      COALESCE(SUM(aic_gross_amount), 0)   AS total_gross_usd
    FROM billing_premium_requests
    ${where}
    GROUP BY date, model
    ORDER BY date ASC, model ASC
  `
    )
    .all(...params) as TokenModelDailyPoint[];
}

/**
 * Per-user, per-model credit efficiency rows used for anomaly detection.
 */
export function getTokenUserModelEfficiency(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[]
): { username: string; model: string; total_tokens: number; total_credits: number; total_gross_usd: number }[] {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);
  return db
    .prepare(
      `
    SELECT
      username,
      model,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
      COALESCE(SUM(aic_quantity), 0)     AS total_credits,
      COALESCE(SUM(aic_gross_amount), 0) AS total_gross_usd
    FROM billing_premium_requests
    ${where}
    GROUP BY username, model
    HAVING total_tokens > 0
    ORDER BY total_credits DESC
  `
    )
    .all(...params) as {
    username: string;
    model: string;
    total_tokens: number;
    total_credits: number;
    total_gross_usd: number;
  }[];
}

/**
 * Thrown when a token CSV export would exceed the row limit.
 *
 * The export is ordered by `date ASC`, so silently applying `LIMIT` would drop
 * the *end* of the requested range and hand back a CSV that looks complete but
 * is not. Callers translate this into a descriptive 400, matching the
 * license-reconciliation export's behaviour.
 */
export class TokenExportTooLargeError extends Error {
  constructor(
    public readonly rowCount: number,
    public readonly limit: number
  ) {
    super(
      `Token export would return ${rowCount.toLocaleString()} rows, above the ${limit.toLocaleString()} row limit. Narrow the date range or add filters.`
    );
    this.name = "TokenExportTooLargeError";
  }
}

/**
 * Detailed per-row token records for CSV export.
 *
 * @throws {TokenExportTooLargeError} when the filtered row count exceeds `limit`.
 */
export function getTokenExportRows(
  start: string,
  end: string,
  filters?: PremiumFilters,
  enterpriseSlugs?: string[],
  limit = 100_000
): Record<string, string | number>[] {
  const db = getDb();
  const { where, params } = buildTokenQuery(start, end, filters, enterpriseSlugs);
  const counted = db
    .prepare(`SELECT COUNT(*) AS cnt FROM billing_premium_requests ${where}`)
    .get(...params) as { cnt: number } | undefined;
  const rowCount = counted?.cnt ?? 0;
  if (rowCount > limit) throw new TokenExportTooLargeError(rowCount, limit);
  return db
    .prepare(
      `
    SELECT
      date,
      username,
      organization,
      repository,
      cost_center_name,
      model,
      sku,
      COALESCE(input_tokens, 0)        AS input_tokens,
      COALESCE(output_tokens, 0)       AS output_tokens,
      COALESCE(cache_read_tokens, 0)   AS cache_read_tokens,
      COALESCE(cache_write_tokens, 0)  AS cache_write_tokens,
      COALESCE(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens, 0) AS total_tokens,
      COALESCE(aic_quantity, 0)        AS total_credits,
      ROUND(COALESCE(aic_quantity, 0) * (${POOL_FRACTION_SQL}), 6)         AS pool_credits,
      ROUND(COALESCE(aic_quantity, 0) * (1.0 - (${POOL_FRACTION_SQL})), 6) AS paid_credits,
      COALESCE(aic_gross_amount, 0)    AS total_gross_usd,
      COALESCE(discount_amount, 0)     AS pool_usd,
      COALESCE(net_amount, 0)          AS paid_usd
    FROM billing_premium_requests
    ${where}
    ORDER BY date ASC, model ASC, username ASC
    LIMIT ?
  `
    )
    .all(...params, limit) as Record<string, string | number>[];
}
