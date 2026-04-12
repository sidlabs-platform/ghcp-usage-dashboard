// Billing Sync Service — fetches billing reports from GitHub Enterprise Billing API
// Supports incremental sync via per-report-type sync state tracking

import { billingClient } from "@/lib/github/billing-client";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import {
  upsertUsageRecords,
  upsertPremiumRequests,
  refreshBillingDailyAggregates,
  getBillingSyncState,
  updateBillingSyncState,
} from "./billing-repo";
import type { BillingReportType } from "@/lib/types/billing";

// ── Helpers ───────────────────────────────────────────────────────────

function getEnterprise(): string {
  const ent = process.env.GITHUB_ENTERPRISE;
  if (!ent) throw new Error("GITHUB_ENTERPRISE environment variable is required");
  return ent;
}

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
  current: number;
  total: number;
  message: string;
}

// ── Date range calculation ────────────────────────────────────────────
// Summarized covers the historical window BEFORE the last 31 days.
// Detailed covers the most recent 31 days (has user-level detail).
// This ensures NO overlap — each date is sourced from exactly one report type.

function getDateRange(
  reportType: BillingReportType,
): { startDate: string; endDate: string } | null {
  const today = todayStr();

  if (reportType === "summarized") {
    // Summarized: from up to 365 days ago → 32 days ago (non-overlapping with detailed's 31-day window)
    const syncState = getBillingSyncState(reportType);
    const startDate = syncState?.last_report_end
      ? syncState.last_report_end
      : subtractDays(today, 365);
    const endDate = subtractDays(today, 32);
    // Skip if start >= end (detailed already covers the window)
    if (startDate >= endDate) return null;
    return { startDate, endDate };
  }

  // Detailed and premium_request: last 31 days
  const maxDays = 31;
  const syncState = getBillingSyncState(reportType);
  let startDate: string;
  if (syncState?.last_report_end) {
    startDate = syncState.last_report_end;
  } else {
    startDate = subtractDays(today, maxDays);
  }
  const earliest = subtractDays(today, maxDays);
  if (startDate < earliest) startDate = earliest;

  return { startDate, endDate: today };
}

// ── Sync individual report types ──────────────────────────────────────

async function syncUsageReport(
  enterprise: string,
  reportType: "detailed" | "summarized",
  onProgress?: (p: BillingSyncProgress) => void,
): Promise<number> {
  const range = getDateRange(reportType);
  if (!range) {
    console.log(`[Billing Sync] ${reportType}: no date range to sync (already covered)`);
    return 0;
  }
  const { startDate, endDate } = range;

  onProgress?.({
    phase: "billing-sync",
    reportType,
    current: 0,
    total: 1,
    message: `Syncing ${reportType} usage report: ${startDate} → ${endDate}`,
  });

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "syncing");

  const records = await billingClient.fetchUsageReport(
    enterprise,
    reportType,
    startDate,
    endDate,
    (msg) =>
      onProgress?.({
        phase: "billing-sync",
        reportType,
        current: 0,
        total: 1,
        message: msg,
      }),
  );

  upsertUsageRecords(records);

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "ok");

  console.log(`[Billing Sync] ${reportType}: upserted ${records.length} usage records`);
  onProgress?.({
    phase: "billing-sync",
    reportType,
    current: 1,
    total: 1,
    message: `${reportType}: synced ${records.length} usage records`,
  });

  return records.length;
}

async function syncPremiumRequestReport(
  enterprise: string,
  onProgress?: (p: BillingSyncProgress) => void,
): Promise<number> {
  const reportType: BillingReportType = "premium_request";
  const range = getDateRange(reportType);
  if (!range) {
    console.log(`[Billing Sync] premium_request: no date range to sync`);
    return 0;
  }
  const { startDate, endDate } = range;

  onProgress?.({
    phase: "billing-sync",
    reportType,
    current: 0,
    total: 1,
    message: `Syncing premium request report: ${startDate} → ${endDate}`,
  });

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "syncing");

  const records = await billingClient.fetchPremiumRequestReport(
    enterprise,
    startDate,
    endDate,
    (msg) =>
      onProgress?.({
        phase: "billing-sync",
        reportType,
        current: 0,
        total: 1,
        message: msg,
      }),
  );

  upsertPremiumRequests(records);

  updateBillingSyncState(reportType, new Date().toISOString(), startDate, endDate, "ok");

  console.log(`[Billing Sync] premium_request: upserted ${records.length} records`);
  onProgress?.({
    phase: "billing-sync",
    reportType,
    current: 1,
    total: 1,
    message: `premium_request: synced ${records.length} records`,
  });

  return records.length;
}

// ── Main entry point ──────────────────────────────────────────────────

export async function syncBilling(
  onProgress?: (p: BillingSyncProgress) => void,
): Promise<{ usageRecords: number; premiumRecords: number; errors: string[] }> {
  if (!isMetricEnabled("billing")) {
    console.log("[Billing Sync] Billing metric is disabled, skipping");
    return { usageRecords: 0, premiumRecords: 0, errors: [] };
  }

  const enterprise = getEnterprise();
  const errors: string[] = [];
  let usageRecords = 0;
  let premiumRecords = 0;

  const reportTypes: BillingReportType[] = ["summarized", "detailed", "premium_request"];
  const totalSteps = reportTypes.length + 1; // +1 for aggregation step
  let step = 0;

  // ── Summarized usage ────────────────────────────────────────────────
  try {
    step++;
    onProgress?.({
      phase: "billing-sync",
      reportType: "summarized",
      current: step,
      total: totalSteps,
      message: "Starting summarized usage sync...",
    });
    usageRecords += await syncUsageReport(enterprise, "summarized", onProgress);
  } catch (err) {
    const msg = formatError("summarized", err);
    errors.push(msg);
    console.error(`[Billing Sync] ${msg}`);
    const prev = getBillingSyncState("summarized");
    updateBillingSyncState("summarized", new Date().toISOString(), prev?.last_report_start ?? "", prev?.last_report_end ?? "", "error", msg);
  }

  // ── Detailed usage ──────────────────────────────────────────────────
  try {
    step++;
    onProgress?.({
      phase: "billing-sync",
      reportType: "detailed",
      current: step,
      total: totalSteps,
      message: "Starting detailed usage sync...",
    });
    usageRecords += await syncUsageReport(enterprise, "detailed", onProgress);
  } catch (err) {
    const msg = formatError("detailed", err);
    errors.push(msg);
    console.error(`[Billing Sync] ${msg}`);
    const prev = getBillingSyncState("detailed");
    updateBillingSyncState("detailed", new Date().toISOString(), prev?.last_report_start ?? "", prev?.last_report_end ?? "", "error", msg);
  }

  // ── Premium requests ────────────────────────────────────────────────
  try {
    step++;
    onProgress?.({
      phase: "billing-sync",
      reportType: "premium_request",
      current: step,
      total: totalSteps,
      message: "Starting premium request sync...",
    });
    premiumRecords += await syncPremiumRequestReport(enterprise, onProgress);
  } catch (err) {
    const msg = formatError("premium_request", err);
    errors.push(msg);
    console.error(`[Billing Sync] ${msg}`);
    const prev = getBillingSyncState("premium_request");
    updateBillingSyncState("premium_request", new Date().toISOString(), prev?.last_report_start ?? "", prev?.last_report_end ?? "", "error", msg);
  }

  // ── Refresh daily aggregates ────────────────────────────────────────
  try {
    step++;
    onProgress?.({
      phase: "billing-sync",
      current: step,
      total: totalSteps,
      message: "Refreshing daily aggregates...",
    });
    refreshBillingDailyAggregates();
    console.log("[Billing Sync] Daily aggregates refreshed");
  } catch (err) {
    const msg = `Failed to refresh daily aggregates: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[Billing Sync] ${msg}`);
  }

  onProgress?.({
    phase: "billing-sync",
    current: totalSteps,
    total: totalSteps,
    message: `Billing sync complete: ${usageRecords} usage records, ${premiumRecords} premium records, ${errors.length} errors`,
  });

  return { usageRecords, premiumRecords, errors };
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
