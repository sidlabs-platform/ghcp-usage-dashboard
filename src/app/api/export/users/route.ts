import { NextRequest, NextResponse } from "next/server";
import { withTimeout } from "@/lib/api/timeout";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  iterateUserSummaries,
  type UserSummary,
} from "@/lib/db/aggregation-queries";
import type { ExportMetadata } from "@/lib/export/csv";
import { escapeCSVValue } from "@/lib/export/csv";
import {
  type UserExportRow,
  userExportColumns,
} from "@/lib/export/user-export";
import { parseDateRangeParams } from "@/lib/utils";

const STREAM_BATCH_SIZE = 250;

function buildDateRangeLabel(
  searchParams: URLSearchParams,
  startDay: string,
  endDay: string,
): string {
  if (searchParams.get("startDate") && searchParams.get("endDate")) {
    return `${startDay} to ${endDay}`;
  }

  const days = searchParams.get("days");
  return days ? `Last ${days} days` : `${startDay} to ${endDay}`;
}

function buildMetadata(
  searchParams: URLSearchParams,
  startDay: string,
  endDay: string,
): ExportMetadata {
  return {
    reportName: "User Explorer",
    dateRange: buildDateRangeLabel(searchParams, startDay, endDay),
    teams: searchParams.get("teams") || undefined,
    orgs: searchParams.get("orgs") || undefined,
  };
}

function buildMetadataLines(metadata: ExportMetadata): string[] {
  const lines = [`Report,${escapeCSVValue(metadata.reportName)}`];

  if (metadata.dateRange) {
    lines.push(`Date Range,${escapeCSVValue(metadata.dateRange)}`);
  }
  if (metadata.teams) {
    lines.push(`Teams,${escapeCSVValue(metadata.teams)}`);
  }
  if (metadata.orgs) {
    lines.push(`Organizations,${escapeCSVValue(metadata.orgs)}`);
  }

  lines.push(`Exported At,${escapeCSVValue(new Date().toLocaleString())}`);
  lines.push("");

  return lines;
}

function getDefaultColumnValue(row: UserExportRow, key: string): string | number {
  switch (key) {
    case "login":
      return row.login;
    case "activeDays":
      return row.activeDays;
    case "locAdded":
      return row.locAdded;
    case "interactions":
      return row.interactions;
    default:
      return "";
  }
}

function formatCsvLine(row: UserExportRow): string {
  return userExportColumns
    .map((column) => {
      const value = column.format
        ? column.format(row)
        : getDefaultColumnValue(row, column.key);
      return escapeCSVValue(value);
    })
    .join(",");
}

function buildHeaderLine(): string {
  return userExportColumns.map((column) => escapeCSVValue(column.label)).join(",");
}

function mapSummaryToExportRow(summary: UserSummary): UserExportRow {
  return {
    login: summary.login,
    activeDays: summary.activeDays,
    locAdded: summary.locAdded,
    interactions: summary.interactions,
    aiCreditsUsed: summary.aiCreditsUsed,
    acceptanceRate: summary.acceptanceRate,
    usedAgent: summary.usedAgent,
    usedChat: summary.usedChat,
    usedCli: summary.usedCli,
    usedCodeReviewActive: summary.usedCodeReviewActive,
    usedCodeReviewPassive: summary.usedCodeReviewPassive,
    usedCodingAgent: summary.usedCodingAgent,
  };
}

function* mapExportRows(
  summaries: Iterable<UserSummary>,
): IterableIterator<UserExportRow> {
  for (const summary of summaries) {
    yield mapSummaryToExportRow(summary);
  }
}

function createCsvStream(
  rows: Iterable<UserExportRow>,
  metadata: ExportMetadata,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const preludeLines = [...buildMetadataLines(metadata), buildHeaderLine()];
  const preludeIterator = preludeLines[Symbol.iterator]();
  const rowIterator = rows[Symbol.iterator]();

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      let emitted = 0;

      while (emitted < STREAM_BATCH_SIZE) {
        const nextPrelude = preludeIterator.next();
        if (!nextPrelude.done) {
          controller.enqueue(encoder.encode(`${nextPrelude.value}\n`));
          emitted += 1;
          continue;
        }

        const nextRow = rowIterator.next();
        if (nextRow.done) {
          controller.close();
          return;
        }

        controller.enqueue(encoder.encode(`${formatCsvLine(nextRow.value)}\n`));
        emitted += 1;
      }
    },
  });
}

async function handler(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const rangeResult = parseDateRangeParams(searchParams, 7);
    if ("error" in rangeResult) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }

    const { start, end } = rangeResult;
    const scopeFilter = parseScopeFilter(searchParams);
    const allowedLogins = scopeFilter.allowedLogins
      ? Array.from(scopeFilter.allowedLogins)
      : undefined;
    const includeInactive = searchParams.get("includeInactive") === "true";
    const search = searchParams.get("search") || undefined;
    const summaries = iterateUserSummaries(
      start,
      end,
      "login",
      "asc",
      search,
      allowedLogins,
      scopeFilter.enterpriseSlugs,
      includeInactive,
    );

    return new NextResponse(
      createCsvStream(mapExportRows(summaries), buildMetadata(searchParams, start, end)),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="copilot-users-export-${start}-to-${end}.csv"`,
          "Cache-Control": "private, no-cache, no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(handler);
