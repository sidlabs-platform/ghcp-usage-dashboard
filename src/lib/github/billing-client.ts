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
import { getEnterpriseAuth } from "@/lib/config/enterprise-config";

// ── API Calls ─────────────────────────────────────────────────────────

function billingPath(enterprise: string, suffix = ""): string {
  return `/enterprises/${enterprise}/settings/billing/reports${suffix}`;
}

/**
 * Create a new billing report export request.
 * The report will be processed asynchronously by GitHub.
 * Billing is enterprise-only, so this always uses PAT auth.
 */
async function createReport(
  enterprise: string,
  reportType: BillingReportType,
  startDate: string,
  endDate: string,
  enterpriseSlug?: string,
): Promise<BillingReportExport> {
  const url = `${GITHUB_API_BASE}${billingPath(enterprise)}`;
  // Enterprise billing → always PAT. Resolve per-enterprise token if slug provided.
  let token: string | undefined;
  if (enterpriseSlug) {
    const auth = getEnterpriseAuth(enterpriseSlug);
    token = auth.token;
  } else {
    token = process.env.GITHUB_TOKEN;
  }
  if (!token) throw new Error("GitHub token is required for billing reports (enterprise endpoint)");

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
  enterpriseSlug?: string,
): Promise<BillingReportExport> {
  return githubFetch<BillingReportExport>(
    billingPath(enterprise, `/${reportId}`),
    3, undefined, enterpriseSlug
  );
}

/**
 * List all billing report exports for the enterprise.
 */
async function listReports(
  enterprise: string,
  enterpriseSlug?: string,
): Promise<BillingReportExport[]> {
  const resp = await githubFetch<BillingReportListResponse>(
    billingPath(enterprise),
    3, undefined, enterpriseSlug
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
  enterpriseSlug?: string,
): Promise<BillingReportExport> {
  const start = Date.now();
  let delayMs = 2000;

  while (Date.now() - start < timeoutMs) {
    const report = await getReport(enterprise, reportId, enterpriseSlug);

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
  // download_urls are pre-signed cloud storage URLs (Azure/S3).
  // Sending an Authorization header to a pre-signed URL causes a 403.
  const resp = await fetch(downloadUrl, {
    headers: { Accept: "text/csv" },
    cache: "no-store",
  });

  if (!resp.ok) {
    throw new Error(`Failed to download billing report CSV: HTTP ${resp.status}`);
  }

  return resp.text();
}

// ── CSV Parsing ───────────────────────────────────────────────────────

/**
 * Parse CSV content into rows, correctly handling:
 * - Quoted fields with commas
 * - Escaped quotes (doubled "")
 * - Multiline quoted fields (newlines inside quotes)
 * - CRLF and LF line endings
 */
function parseCSV<T>(csvContent: string): T[] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < csvContent.length; i++) {
    const ch = csvContent[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < csvContent.length && csvContent[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      currentRow.push(currentField.trim());
      currentField = "";
    } else if (ch === "\r") {
      // skip CR, handle LF next
    } else if (ch === "\n") {
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.some((v) => v.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentField += ch;
    }
  }

  // Flush last field/row
  currentRow.push(currentField.trim());
  if (currentRow.some((v) => v.length > 0)) {
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];

  const headers = rows[0];
  const result: T[] = [];

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    result.push(row as T);
  }

  return result;
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
  enterpriseSlug?: string,
): Promise<T[]> {
  onProgress?.(`Creating ${reportType} report for ${startDate} to ${endDate}...`);
  const report = await createReport(enterprise, reportType, startDate, endDate, enterpriseSlug);

  onProgress?.(`Report ${report.id} created, waiting for completion...`);
  const completed = await waitForReport(
    enterprise,
    report.id,
    undefined,
    onProgress,
    enterpriseSlug,
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
    // Avoid spread to prevent stack overflow with large datasets
    for (const r of records) allRecords.push(r);
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
  enterpriseSlug?: string,
): Promise<BillingUsageRecord[]> {
  return fetchAndParseReport(
    enterprise,
    reportType,
    startDate,
    endDate,
    parseUsageCSV,
    onProgress,
    enterpriseSlug,
  );
}

async function fetchPremiumRequestReport(
  enterprise: string,
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void,
  enterpriseSlug?: string,
): Promise<BillingPremiumRequestRecord[]> {
  return fetchAndParseReport(
    enterprise,
    "premium_request",
    startDate,
    endDate,
    parsePremiumRequestCSV,
    onProgress,
    enterpriseSlug,
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
