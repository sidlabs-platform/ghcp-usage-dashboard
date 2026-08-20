import { NextRequest, NextResponse } from "next/server";
import {
  getSeatLifecycleExportRows,
  SEAT_LIFECYCLE_EXPORT_MAX_ROWS,
  type SeatLifecycleEventType,
  type SeatLifecycleQuery,
  type SeatLifecycleRow,
} from "@/lib/db/seat-lifecycle-repo";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { parseSeatLifecycleWindow } from "@/lib/api/seat-lifecycle-window";
import { escapeCSVValue } from "@/lib/export/csv";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-cache, no-store, max-age=0" };

interface CsvColumnDef {
  label: string;
  value: (row: SeatLifecycleRow) => unknown;
}

const COLUMNS: CsvColumnDef[] = [
  { label: "event_type", value: (r) => r.event_type },
  { label: "event_date", value: (r) => r.event_date },
  { label: "user_login", value: (r) => r.user_login },
  { label: "user_id", value: (r) => r.user_id },
  { label: "enterprise", value: (r) => r.enterprise_slug },
  { label: "org", value: (r) => r.org_slug },
  { label: "plan_type", value: (r) => r.plan_type },
  { label: "assigning_team_slug", value: (r) => r.assigning_team_slug },
  { label: "assigning_team_name", value: (r) => r.assigning_team_name },
  { label: "last_activity_at", value: (r) => r.last_activity_at },
  { label: "occurred_at", value: (r) => r.occurred_at },
  { label: "source", value: (r) => r.source },
  { label: "display_login", value: (r) => r.display_login },
  { label: "login_resolved", value: (r) => r.login_resolved },
];

function isEventTypeFilter(value: string): value is SeatLifecycleEventType | "all" {
  return value === "onboarded" || value === "offboarded" || value === "all";
}

function buildCsv(rows: SeatLifecycleRow[], metadataLines: string[]): string {
  const lines = [...metadataLines, COLUMNS.map((c) => escapeCSVValue(c.label)).join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((col) => escapeCSVValue(col.value(row))).join(","));
  }
  // CRLF row separator per RFC4180, matching the license-reconciliation export.
  return lines.join("\r\n");
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    const window = parseSeatLifecycleWindow(params);
    if ("error" in window) {
      return NextResponse.json({ error: window.error }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const rawType = params.get("eventType") || "all";
    if (!isEventTypeFilter(rawType)) {
      return NextResponse.json(
        { error: `Invalid eventType "${rawType}". Allowed: onboarded, offboarded, all.` },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const filter = parseScopeFilter(params);
    const query: SeatLifecycleQuery = {
      start: window.start,
      end: window.end,
      enterpriseSlugs: filter.enterpriseSlugs,
      orgs: filter.selectedOrgs.length > 0 ? filter.selectedOrgs : undefined,
      allowedLogins: filter.allowedLogins,
    };

    let result;
    try {
      result = getSeatLifecycleExportRows(query, rawType);
    } catch (err) {
      // No ledger tables yet — export an empty (header-only) CSV rather than
      // failing, mirroring the JSON route's graceful degradation.
      console.error("[api/export/seat-lifecycle] Ledger unavailable, exporting empty CSV:", err);
      result = { rows: [], truncated: false, total: 0 };
    }

    if (result.truncated) {
      return NextResponse.json(
        {
          error:
            `Result set too large (${result.total} rows, limit ${SEAT_LIFECYCLE_EXPORT_MAX_ROWS}). ` +
            "Narrow the scope or shorten the date range before exporting.",
        },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const csv = buildCsv(result.rows, [
      `Report,${escapeCSVValue("Seat Onboarding & Offboarding")}`,
      `Window,${escapeCSVValue(`${window.start} to ${window.end}`)}`,
      `Event Type,${escapeCSVValue(rawType)}`,
      `Exported At,${escapeCSVValue(new Date().toISOString())}`,
      "",
    ]);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="seat-lifecycle-${window.start}-to-${window.end}-${rawType}.csv"`,
        ...NO_STORE_HEADERS,
      },
    });
  } catch (err) {
    console.error("Seat lifecycle CSV export error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export const GET = withRateLimit(withTimeout(handler));
