// GitHub Enterprise Billing Reports API Client
// Handles async report creation, polling, CSV download and parsing
// API docs: https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage-reports

import { githubFetch, sleep, GITHUB_API_BASE } from "./api-base";
import type {
  BillingReportExport,
  BillingReportListResponse,
  BillingReportType,
  BillingUsageRecord,
  BillingPremiumRequestRecord,
  UsageCSVRow,
  PremiumRequestCSVRow,
} from "@/lib/types/billing";
import { deriveChargeScope } from "@/lib/types/billing";

// ── API Calls ─────────────────────────────────────────────────────────

function billingPath(enterprise: string, suffix = ""): string {
  return `/enterprises/${enterprise}/settings/billing/reports${suffix}`;
}

/**
 * Create a new billing report export request.
 * The report will be processed asynchronously by GitHub.
 */
async function createReport(
  enterprise: string,
  reportType: BillingReportType,
  startDate: string,
  endDate: string,
): Promise<BillingReportExport> {
  const url = `${GITHUB_API_BASE}${billingPath(enterprise)}`;
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN environment variable is required");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      report_type: reportType,
      start_date: startDate,
      end_date: endDate,
      send_email: false,
    }),
    cache: "no-store",
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Failed to create billing report (${reportType}): HTTP ${resp.status} — ${body}`,
    );
  }

  return resp.json() as Promise<BillingReportExport>;
}

/**
 * Get the current status and details of a billing report export.
 */
async function getReport(
  enterprise: string,
  reportId: string,
): Promise<BillingReportExport> {
  return githubFetch<BillingReportExport>(
    billingPath(enterprise, `/${reportId}`),
  );
}

/**
 * List all billing report exports for the enterprise.
 */
async function listReports(
  enterprise: string,
): Promise<BillingReportExport[]> {
  const resp = await githubFetch<BillingReportListResponse>(
    billingPath(enterprise),
  );
  return resp.usage_report_exports;
}

/**
 * Poll until a billing report reaches "completed" or "failed" status.
 * Uses exponential backoff: 2s, 4s, 8s, 16s, 30s, 30s, ...
 * Timeout defaults to 5 minutes.
 */
async function waitForReport(
  enterprise: string,
  reportId: string,
  timeoutMs = 5 * 60 * 1000,
  onProgress?: (msg: string) => void,
): Promise<BillingReportExport> {
  const start = Date.now();
  let delayMs = 2000;

  while (Date.now() - start < timeoutMs) {
    const report = await getReport(enterprise, reportId);

    if (report.status === "completed") return report;
    if (report.status === "failed") {
      throw new Error(`Billing report ${reportId} failed`);
    }

    onProgress?.(
      `Report ${reportId} status: ${report.status}, waiting ${Math.round(delayMs / 1000)}s...`,
    );
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 30_000);
  }

  throw new Error(
    `Billing report ${reportId} timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

/**
 * Download the CSV content from a report's download URL.
 */
async function downloadReportCSV(downloadUrl: string): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN environment variable is required");

  const resp = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/csv",
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    throw new Error(`Failed to download billing report CSV: HTTP ${resp.status}`);
  }

  return resp.text();
}

// ── CSV Parsing ───────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      values.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values;
}

function parseCSV<T>(csvContent: string): T[] {
  const lines = csvContent.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: T[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row as T);
  }

  return rows;
}

/**
 * Parse metered usage CSV into typed records.
 */
function parseUsageCSV(csvContent: string): BillingUsageRecord[] {
  const rawRows = parseCSV<UsageCSVRow>(csvContent);
  return rawRows.map((r) => ({
    date: r.date || "",
    product: r.product || "",
    sku: r.sku || "",
    quantity: parseFloat(r.quantity) || 0,
    unit_type: r.unit_type || "",
    applied_cost_per_quantity: parseFloat(r.applied_cost_per_quantity) || 0,
    gross_amount: parseFloat(r.gross_amount) || 0,
    discount_amount: parseFloat(r.discount_amount) || 0,
    net_amount: parseFloat(r.net_amount) || 0,
    organization: r.organization || "",
    repository: r.repository || "",
    username: r.username || "",
    workflow_path: r.workflow_path || "",
    cost_center_name: r.cost_center_name || "",
    charge_scope: deriveChargeScope(r.product || "", r.sku || ""),
  }));
}

/**
 * Parse premium request CSV into typed records.
 */
function parsePremiumRequestCSV(
  csvContent: string,
): BillingPremiumRequestRecord[] {
  const rawRows = parseCSV<PremiumRequestCSVRow>(csvContent);
  return rawRows.map((r) => ({
    date: r.date || "",
    product: r.product || "",
    sku: r.sku || "",
    quantity: parseFloat(r.quantity) || 0,
    unit_type: r.unit_type || "",
    applied_cost_per_quantity: parseFloat(r.applied_cost_per_quantity) || 0,
    gross_amount: parseFloat(r.gross_amount) || 0,
    discount_amount: parseFloat(r.discount_amount) || 0,
    net_amount: parseFloat(r.net_amount) || 0,
    username: r.username || "",
    organization: r.organization || "",
    model: r.model || "",
    exceeds_quota: r.exceeds_quota || "FALSE",
    total_monthly_quota: parseFloat(r.total_monthly_quota || "0") || 0,
    charge_scope: "user" as const,
  }));
}

// ── High-level orchestration ──────────────────────────────────────────

/**
 * Create a billing report, wait for completion, download and parse CSV.
 * Returns parsed records.
 */
async function fetchAndParseReport<T>(
  enterprise: string,
  reportType: BillingReportType,
  startDate: string,
  endDate: string,
  parser: (csv: string) => T[],
  onProgress?: (msg: string) => void,
): Promise<T[]> {
  onProgress?.(`Creating ${reportType} report for ${startDate} to ${endDate}...`);
  const report = await createReport(enterprise, reportType, startDate, endDate);

  onProgress?.(`Report ${report.id} created, waiting for completion...`);
  const completed = await waitForReport(
    enterprise,
    report.id,
    undefined,
    onProgress,
  );

  if (!completed.download_urls || completed.download_urls.length === 0) {
    onProgress?.(`Report ${report.id} completed but has no download URLs`);
    return [];
  }

  const allRecords: T[] = [];
  for (const url of completed.download_urls) {
    onProgress?.(`Downloading CSV from report ${report.id}...`);
    const csv = await downloadReportCSV(url);
    const records = parser(csv);
    allRecords.push(...records);
  }

  onProgress?.(
    `Parsed ${allRecords.length} records from ${reportType} report`,
  );
  return allRecords;
}

async function fetchUsageReport(
  enterprise: string,
  reportType: "detailed" | "summarized",
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void,
): Promise<BillingUsageRecord[]> {
  return fetchAndParseReport(
    enterprise,
    reportType,
    startDate,
    endDate,
    parseUsageCSV,
    onProgress,
  );
}

async function fetchPremiumRequestReport(
  enterprise: string,
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void,
): Promise<BillingPremiumRequestRecord[]> {
  return fetchAndParseReport(
    enterprise,
    "premium_request",
    startDate,
    endDate,
    parsePremiumRequestCSV,
    onProgress,
  );
}

// ── Exported client ───────────────────────────────────────────────────

export const billingClient = {
  createReport,
  getReport,
  listReports,
  waitForReport,
  downloadReportCSV,
  parseUsageCSV,
  parsePremiumRequestCSV,
  fetchUsageReport,
  fetchPremiumRequestReport,
};
