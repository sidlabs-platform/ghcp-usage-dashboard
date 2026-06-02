// Billing Sync Service — fetches billing reports from GitHub Enterprise Billing API
// Supports incremental sync via per-report-type sync state tracking

import { billingClient } from "@/lib/github/billing-client";
import { isBillingEnabledForEnterprise, isBillingSubEnabledForEnterprise } from "@/lib/config/enterprise-config";
import {
  upsertUsageRecords,
  upsertPremiumRequests,
  refreshBillingDailyAggregates,
  getBillingSyncState,
  updateBillingSyncState,
} from "./billing-repo";
import type { BillingReportType } from "@/lib/types/billing";

// ── Helpers ───────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

const PERMISSION_ERROR_MSG =
  "Billing API requires 'Enterprise administration' enterprise permissions (write). " +
  "Please ensure your GITHUB_TOKEN has this permission.";

// ── Progress type ─────────────────────────────────────────────────────

export interface BillingSyncProgress {
  phase: string;
  reportType?: string;
  enterpriseSlug?: string;
  current: number;
  total: number;
  message: string;
}

// ── Date range calculation ────────────────────────────────────────────
// Summarized covers the historical window BEFORE the last 30 days.
// Detailed covers the most recent 30 days (has user-level detail).
// The API maximum inclusive range is 31 days, so maxDays=30 ⇒ [today-30, today] = 31 inclusive.
// This ensures NO overlap — each date is sourced from exactly one report type.

function getDateRange(
  reportType: BillingReportType,
  enterpriseSlug: string,
): { startDate: string; endDate: string } | null {
  const today = todayStr();

  // Helper: advance one day past last_report_end to avoid re-fetching the last day
  const nextDay = (dateStr: string) => subtractDays(dateStr, -1);

  // Only trust sync state if the last sync succeeded
  const syncState = getBillingSyncState(reportType, enterpriseSlug);
  const lastEnd = syncState?.status === "ok" ? syncState.last_report_end : null;

  if (reportType === "summarized") {
    // Summarized: from up to 365 days ago → 31 days ago (non-overlapping with detailed's 30-day window)
    const startDate = lastEnd
      ? nextDay(lastEnd)
      : subtractDays(today, 365);
    const endDate = subtractDays(today, 31);
    // Skip if start > end (detailed already covers the window)
    if (startDate > endDate) return null;
    return { startDate, endDate };
  }

  // Detailed and premium_request: last 30 days (31 inclusive with endDate=today)
  const maxDays = 30;
  let startDate: string;
  if (lastEnd) {
    startDate = nextDay(lastEnd);
  } else {
    startDate = subtractDays(today, maxDays);
  }
  const earliest = subtractDays(today, maxDays);
  if (startDate < earliest) startDate = earliest;

  // Skip if start > end (already fully synced)
  if (startDate > today) return null;

  return { startDate, endDate: today };
}

// ── Sync individual report types ──────────────────────────────────────

async function syncUsageReport(
  enterpriseSlug: string,
  reportType: "detailed" | "summarized",
  onProgress?: (p: BillingSyncProgress) => void,
): Promise<number> {
  const range = getDateRange(reportType, enterpriseSlug);
  if (!range) {
    console.log(`[Billing Sync] ${reportType}: no date range to sync (already covered)`);
    return 0;
  }
  const { startDate, endDate } = range;

  onProgress?.({
    phase: "billing-sync",
    reportType,
    enterpriseSlug,
    current: 0,
    total: 1,
    message: `Syncing ${reportType} usage report: ${startDate} → ${endDate}`,
  });

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "syncing", undefined, enterpriseSlug);

  const records = await billingClient.fetchUsageReport(
    enterpriseSlug,
    reportType,
    startDate,
    endDate,
    (msg) =>
      onProgress?.({
        phase: "billing-sync",
        reportType,
        enterpriseSlug,
        current: 0,
        total: 1,
        message: msg,
      }),
    enterpriseSlug,
  );

  upsertUsageRecords(enterpriseSlug, records);

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "ok", undefined, enterpriseSlug);

  console.log(`[Billing Sync] ${reportType}: upserted ${records.length} usage records`);
  onProgress?.({
    phase: "billing-sync",
    reportType,
    enterpriseSlug,
    current: 1,
    total: 1,
    message: `${reportType}: synced ${records.length} usage records`,
  });

  return records.length;
}

async function syncPremiumRequestReport(
  enterpriseSlug: string,
  onProgress?: (p: BillingSyncProgress) => void,
): Promise<number> {
  const reportType: BillingReportType = "premium_request";
  const range = getDateRange(reportType, enterpriseSlug);
  if (!range) {
    console.log(`[Billing Sync] premium_request: no date range to sync`);
    return 0;
  }
  const { startDate, endDate } = range;

  onProgress?.({
    phase: "billing-sync",
    reportType,
    enterpriseSlug,
    current: 0,
    total: 1,
    message: `Syncing premium request report: ${startDate} → ${endDate}`,
  });

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "syncing", undefined, enterpriseSlug);

  const records = await billingClient.fetchPremiumRequestReport(
    enterpriseSlug,
    startDate,
    endDate,
    (msg) =>
      onProgress?.({
        phase: "billing-sync",
        reportType,
        enterpriseSlug,
        current: 0,
        total: 1,
        message: msg,
      }),
    enterpriseSlug,
  );

  upsertPremiumRequests(enterpriseSlug, records);

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "ok", undefined, enterpriseSlug);

  console.log(`[Billing Sync] premium_request: upserted ${records.length} records`);
  onProgress?.({
    phase: "billing-sync",
    reportType,
    enterpriseSlug,
    current: 1,
    total: 1,
    message: `premium_request: synced ${records.length} records`,
  });

  return records.length;
}

async function syncAiCreditReport(
  enterpriseSlug: string,
  onProgress?: (p: BillingSyncProgress) => void,
): Promise<number> {
  const reportType: BillingReportType = "ai_credit";
  const range = getDateRange(reportType, enterpriseSlug);
  if (!range) {
    console.log(`[Billing Sync] ai_credit: no date range to sync`);
    return 0;
  }
  const { startDate, endDate } = range;

  onProgress?.({
    phase: "billing-sync",
    reportType,
    enterpriseSlug,
    current: 0,
    total: 1,
    message: `Syncing AI credit report: ${startDate} → ${endDate}`,
  });

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "syncing", undefined, enterpriseSlug);

  const records = await billingClient.fetchAiCreditReport(
    enterpriseSlug,
    startDate,
    endDate,
    (msg) =>
      onProgress?.({
        phase: "billing-sync",
        reportType,
        enterpriseSlug,
        current: 0,
        total: 1,
        message: msg,
      }),
    enterpriseSlug,
  );

  upsertPremiumRequests(enterpriseSlug, records);

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "ok", undefined, enterpriseSlug);

  console.log(`[Billing Sync] ai_credit: upserted ${records.length} records`);
  onProgress?.({
    phase: "billing-sync",
    reportType,
    enterpriseSlug,
    current: 1,
    total: 1,
    message: `ai_credit: synced ${records.length} records`,
  });

  return records.length;
}

// ── Main entry point ──────────────────────────────────────────────────

export async function syncBilling(
  enterpriseSlug: string,
  onProgress?: (p: BillingSyncProgress) => void,
): Promise<{ usageRecords: number; premiumRecords: number; aiCreditRecords: number; errors: string[] }> {
  if (!isBillingEnabledForEnterprise(enterpriseSlug)) {
    console.log("[Billing Sync] Billing is disabled (enterprise off or billing metric disabled), skipping");
    return { usageRecords: 0, premiumRecords: 0, aiCreditRecords: 0, errors: [] };
  }

  const errors: string[] = [];
  let usageRecords = 0;
  let premiumRecords = 0;
  let aiCreditRecords = 0;

  // Compute totalSteps dynamically based on enabled sub-toggles
  let totalSteps = 1; // aggregation always runs
  if (isBillingSubEnabledForEnterprise(enterpriseSlug, "meteredUsage")) totalSteps += 2; // summarized + detailed
  if (isBillingSubEnabledForEnterprise(enterpriseSlug, "premiumRequests")) totalSteps += 1;
  if (isBillingSubEnabledForEnterprise(enterpriseSlug, "aiCredits")) totalSteps += 1;
  let step = 0;

  // ── Summarized usage ────────────────────────────────────────────────
  if (isBillingSubEnabledForEnterprise(enterpriseSlug, "meteredUsage")) {
    try {
      step++;
      onProgress?.({
        phase: "billing-sync",
        reportType: "summarized",
        enterpriseSlug,
        current: step,
        total: totalSteps,
        message: "Starting summarized usage sync...",
      });
      usageRecords += await syncUsageReport(enterpriseSlug, "summarized", onProgress);
    } catch (err) {
      const msg = formatError("summarized", err);
      errors.push(msg);
      console.error(`[Billing Sync] ${msg}`);
      const prev = getBillingSyncState("summarized", enterpriseSlug);
      updateBillingSyncState("summarized", new Date().toISOString(), prev?.last_report_start ?? "", prev?.last_report_end ?? "", "error", msg, enterpriseSlug);
    }

    // ── Detailed usage ──────────────────────────────────────────────────
    try {
      step++;
      onProgress?.({
        phase: "billing-sync",
        reportType: "detailed",
        enterpriseSlug,
        current: step,
        total: totalSteps,
        message: "Starting detailed usage sync...",
      });
      usageRecords += await syncUsageReport(enterpriseSlug, "detailed", onProgress);
    } catch (err) {
      const msg = formatError("detailed", err);
      errors.push(msg);
      console.error(`[Billing Sync] ${msg}`);
      const prev = getBillingSyncState("detailed", enterpriseSlug);
      updateBillingSyncState("detailed", new Date().toISOString(), prev?.last_report_start ?? "", prev?.last_report_end ?? "", "error", msg, enterpriseSlug);
    }
  }

  // ── Premium requests ────────────────────────────────────────────────
  if (isBillingSubEnabledForEnterprise(enterpriseSlug, "premiumRequests")) {
    try {
      step++;
      onProgress?.({
        phase: "billing-sync",
        reportType: "premium_request",
        enterpriseSlug,
        current: step,
        total: totalSteps,
        message: "Starting premium request sync...",
      });
      premiumRecords += await syncPremiumRequestReport(enterpriseSlug, onProgress);
    } catch (err) {
      const msg = formatError("premium_request", err);
      errors.push(msg);
      console.error(`[Billing Sync] ${msg}`);
      const prev = getBillingSyncState("premium_request", enterpriseSlug);
      updateBillingSyncState("premium_request", new Date().toISOString(), prev?.last_report_start ?? "", prev?.last_report_end ?? "", "error", msg, enterpriseSlug);
    }
  }

  // ── AI credits ──────────────────────────────────────────────────────
  if (isBillingSubEnabledForEnterprise(enterpriseSlug, "aiCredits")) {
    try {
      step++;
      onProgress?.({
        phase: "billing-sync",
        reportType: "ai_credit",
        enterpriseSlug,
        current: step,
        total: totalSteps,
        message: "Starting AI credit sync...",
      });
      aiCreditRecords += await syncAiCreditReport(enterpriseSlug, onProgress);
    } catch (err) {
      const msg = formatError("ai_credit", err);
      errors.push(msg);
      console.error(`[Billing Sync] ${msg}`);
      const prev = getBillingSyncState("ai_credit", enterpriseSlug);
      updateBillingSyncState("ai_credit", new Date().toISOString(), prev?.last_report_start ?? "", prev?.last_report_end ?? "", "error", msg, enterpriseSlug);
    }
  }

  // ── Refresh daily aggregates ────────────────────────────────────────
  try {
    step++;
    onProgress?.({
      phase: "billing-sync",
      enterpriseSlug,
      current: step,
      total: totalSteps,
      message: "Refreshing daily aggregates...",
    });
    refreshBillingDailyAggregates(enterpriseSlug);
    console.log("[Billing Sync] Daily aggregates refreshed");
  } catch (err) {
    const msg = `Failed to refresh daily aggregates: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[Billing Sync] ${msg}`);
  }

  onProgress?.({
    phase: "billing-sync",
    enterpriseSlug,
    current: totalSteps,
    total: totalSteps,
    message: `Billing sync complete: ${usageRecords} usage records, ${premiumRecords} premium records, ${aiCreditRecords} AI credit records, ${errors.length} errors`,
  });

  return { usageRecords, premiumRecords, aiCreditRecords, errors };
}

// ── Error formatting ──────────────────────────────────────────────────

function formatError(reportType: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Surface a clear message for 403 permission errors
  if (raw.includes("403")) {
    return `${reportType}: ${PERMISSION_ERROR_MSG}`;
  }

  return `${reportType}: ${raw}`;
}
