import { NextRequest, NextResponse } from "next/server";
import { withTimeout } from "@/lib/api/timeout";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { getTokenExportRows } from "@/lib/db/billing-repo";
import type { PremiumFilters } from "@/lib/db/billing-repo";
import { escapeCSVValue } from "@/lib/export/csv";

/**
 * CSV export of the per-model token breakdown from the AI usage report,
 * including the derived pool vs. additional credit split.
 */
const COLUMNS: { key: string; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "username", label: "User" },
  { key: "organization", label: "Organization" },
  { key: "repository", label: "Repository" },
  { key: "cost_center_name", label: "Cost Center" },
  { key: "model", label: "Model" },
  { key: "sku", label: "SKU" },
  { key: "input_tokens", label: "Input Tokens" },
  { key: "output_tokens", label: "Output Tokens" },
  { key: "cache_read_tokens", label: "Cache Read Tokens" },
  { key: "cache_write_tokens", label: "Cache Write Tokens" },
  { key: "total_tokens", label: "Total Tokens" },
  { key: "total_credits", label: "AI Credits" },
  { key: "pool_credits", label: "Pool Credits" },
  { key: "paid_credits", label: "Additional Credits" },
  { key: "total_gross_usd", label: "Gross USD" },
  { key: "pool_usd", label: "Pool USD (discount)" },
  { key: "paid_usd", label: "Additional USD (net)" },
];

async function handler(request: NextRequest) {
  try {
    if (
      !isBillingSubEnabledForAnyEnterprise("premiumRequests") &&
      !isBillingSubEnabledForAnyEnterprise("aiCredits")
    ) {
      return NextResponse.json({ error: "Billing reports are not enabled" }, { status: 400 });
    }

    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { start, end } = getDateRange(daysResult.days);

    const scope = parseScopeFilter(params);
    const filters: PremiumFilters = {
      username: params.get("username") || undefined,
      organization: params.get("organization")?.split(",").filter(Boolean),
      model: params.get("model")?.split(",").filter(Boolean),
    };
    if (scope.allowedLogins) filters.allowedLogins = Array.from(scope.allowedLogins);
    if (scope.selectedOrgs.length > 0) filters.scopeOrgs = scope.selectedOrgs;

    const rows = getTokenExportRows(start, end, filters, scope.enterpriseSlugs);

    const lines = [
      COLUMNS.map((c) => escapeCSVValue(c.label)).join(","),
      ...rows.map((r) => COLUMNS.map((c) => escapeCSVValue(r[c.key] ?? "")).join(",")),
    ];

    return new NextResponse(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="copilot-token-usage-${start}-to-${end}.csv"`,
        "Cache-Control": "private, no-cache, no-store, max-age=0",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(handler);
