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
  BillingReportType,
  ChargeScope,
  PremiumRequestUserSummary,
  PremiumRequestModelSummary,
} from "@/lib/types/billing";

// ── Filter Interfaces ─────────────────────────────────────────────────

export interface BillingFilters {
  product?: string[];
  sku?: string[];
  organization?: string[];
  username?: string;
  chargeScope?: ChargeScope;
  costCenter?: string;
}

export interface PremiumFilters {
  username?: string;
  organization?: string[];
  model?: string[];
  exceedsQuota?: boolean;
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
  if (filters.organization?.length) {
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
  if (filters.organization?.length) {
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
}

function buildWhereClause(clauses: string[]): string {
  return clauses.length ? " WHERE " + clauses.join(" AND ") : "";
}

// ── Sort Column Whitelists ────────────────────────────────────────────

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
]);

// ── Upsert Operations ────────────────────────────────────────────────

export function upsertUsageRecords(records: BillingUsageRecord[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO billing_usage_records
      (date, product, sku, quantity, unit_type, applied_cost_per_quantity,
       gross_amount, discount_amount, net_amount, organization, repository,
       username, workflow_path, cost_center_name, charge_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of records) {
      stmt.run(
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

export function upsertPremiumRequests(
  records: BillingPremiumRequestRecord[]
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO billing_premium_requests
      (date, product, sku, quantity, unit_type, applied_cost_per_quantity,
       gross_amount, discount_amount, net_amount, username, organization,
       model, exceeds_quota, total_monthly_quota, charge_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of records) {
      stmt.run(
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
        r.model,
        r.exceeds_quota,
        r.total_monthly_quota,
        r.charge_scope
      );
    }
  });
  tx();
}

// ── Query Operations ──────────────────────────────────────────────────

export function getOverviewKPIs(
  start: string,
  end: string
): BillingOverviewKPIs {
  const db = getDb();

  // Metered usage totals
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
    WHERE date >= ? AND date <= ?
  `
    )
    .get(start, end) as BillingOverviewKPIs;

  // Premium request totals (always user-level)
  const premium = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(net_amount), 0)       AS premNet,
      COALESCE(SUM(gross_amount), 0)     AS premGross,
      COALESCE(SUM(discount_amount), 0)  AS premDiscount
    FROM billing_premium_requests
    WHERE date >= ? AND date <= ?
  `
    )
    .get(start, end) as { premNet: number; premGross: number; premDiscount: number } | undefined;

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
  filters?: BillingFilters
): BillingDailyAggregate[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
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
  filters?: BillingFilters
): BillingProductBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
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
  filters?: BillingFilters
): BillingOrgBreakdown[] {
  const db = getDb();
  const clauses: string[] = [
    "date >= ?",
    "date <= ?",
    "organization != ''",
  ];
  const params: unknown[] = [start, end];
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
  filters?: BillingFilters
): BillingUserBreakdown[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?", "username != ''"];
  const params: unknown[] = [start, end];
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
  filters?: BillingFilters
): { records: BillingUsageRecord[]; total: number } {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
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
  filters?: PremiumFilters
): { records: BillingPremiumRequestRecord[]; total: number } {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
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
           model, exceeds_quota, total_monthly_quota, charge_scope
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
  filters?: PremiumFilters
): PremiumRequestUserSummary[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      username,
      organization,
      COALESCE(SUM(quantity), 0)  AS total_requests,
      COALESCE(SUM(CASE WHEN exceeds_quota = 'FALSE' THEN quantity ELSE 0 END), 0) AS within_quota,
      COALESCE(SUM(CASE WHEN exceeds_quota = 'TRUE'  THEN quantity ELSE 0 END), 0) AS over_quota,
      COALESCE(MAX(total_monthly_quota), 0) AS quota_limit,
      CASE
        WHEN MAX(total_monthly_quota) > 0
        THEN ROUND(COALESCE(SUM(quantity), 0) * 100.0 / MAX(total_monthly_quota), 2)
        ELSE 0
      END AS utilization_pct,
      COALESCE(SUM(net_amount), 0) AS total_net
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
  filters?: PremiumFilters
): PremiumRequestModelSummary[] {
  const db = getDb();
  const clauses: string[] = ["date >= ?", "date <= ?"];
  const params: unknown[] = [start, end];
  appendPremiumFilters(clauses, params, filters);

  return db
    .prepare(
      `
    SELECT
      model,
      COALESCE(SUM(quantity), 0)         AS total_requests,
      COALESCE(SUM(net_amount), 0)       AS total_net,
      COUNT(DISTINCT username)           AS unique_users
    FROM billing_premium_requests
    ${buildWhereClause(clauses)}
    GROUP BY model
    ORDER BY total_requests DESC
  `
    )
    .all(...params) as PremiumRequestModelSummary[];
}

// ── Aggregate Operations ──────────────────────────────────────────────

export function refreshBillingDailyAggregates(): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM billing_daily_aggregate`).run();
    db.prepare(
      `
      INSERT INTO billing_daily_aggregate
        (day, product, charge_scope, total_quantity, total_gross, total_discount, total_net, record_count)
      SELECT
        date,
        product,
        charge_scope,
        COALESCE(SUM(quantity), 0),
        COALESCE(SUM(gross_amount), 0),
        COALESCE(SUM(discount_amount), 0),
        COALESCE(SUM(net_amount), 0),
        COUNT(*)
      FROM billing_usage_records
      GROUP BY date, product, charge_scope
    `
    ).run();
  });
  tx();
}

// ── Sync State ────────────────────────────────────────────────────────

export function getBillingSyncState(
  reportType: BillingReportType
): BillingSyncState | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT report_type, last_synced_at, last_report_start, last_report_end, status, error_message
       FROM billing_sync_state WHERE report_type = ?`
    )
    .get(reportType) as BillingSyncState | undefined;
  return row ?? null;
}

export function updateBillingSyncState(
  reportType: BillingReportType,
  lastSyncedAt: string,
  lastReportStart: string,
  lastReportEnd: string,
  status: string,
  errorMessage?: string
): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO billing_sync_state
      (report_type, last_synced_at, last_report_start, last_report_end, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_type) DO UPDATE SET
      last_synced_at   = excluded.last_synced_at,
      last_report_start = excluded.last_report_start,
      last_report_end   = excluded.last_report_end,
      status            = excluded.status,
      error_message     = excluded.error_message
  `
  ).run(
    reportType,
    lastSyncedAt,
    lastReportStart,
    lastReportEnd,
    status,
    errorMessage ?? null
  );
}

// ── Filter Options ────────────────────────────────────────────────────

export function getUsageFilterOptions(
  start: string,
  end: string
): {
  products: string[];
  skus: string[];
  organizations: string[];
  costCenters: string[];
} {
  const db = getDb();
  const where = "WHERE date >= ? AND date <= ?";
  const params = [start, end];

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
  end: string
): {
  models: string[];
  organizations: string[];
  users: string[];
} {
  const db = getDb();
  const where = "WHERE date >= ? AND date <= ?";
  const params = [start, end];

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
