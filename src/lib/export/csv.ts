/**
 * CSV generation utilities.
 * Handles conversion of data arrays to CSV strings and
 * paginated API fetching for full data export.
 */

export interface CSVColumn {
  key: string;
  label: string;
  /** Optional formatter — receives the row and returns a string value */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  format?: (row: any) => string;
}

export interface ExportMetadata {
  reportName: string;
  dateRange?: string;
  teams?: string;
  orgs?: string;
}

// Characters that spreadsheet applications (Excel, Google Sheets, etc.) may
// interpret as the start of a formula/command when a CSV cell is opened.
// Tab, CR, and LF are included per OWASP CSV-injection guidance: they are
// themselves recognized as dangerous leading bytes (not just as separators
// for a following `=`/`+`/`-`/`@`), since some tools treat a leading
// control-whitespace byte specially in addition to whatever follows it.
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@", "|", "%", "\t", "\r", "\n"]);

/**
 * True when a string's effective first character (after skipping any
 * leading plain ASCII spaces, `0x20`) is a formula-injection trigger. This
 * catches values that hide a dangerous prefix behind leading spaces (e.g.
 * `"  =SUM(A1)"`), not just a literal leading `=`/`+`/`-`/`@`/`|`/`%`/tab/CR/LF.
 * Leading tabs/CRs/LFs are *not* skipped past — each is itself a recognized
 * trigger character, so encountering one immediately reports a risk rather
 * than continuing to look further into the string.
 */
function hasFormulaInjectionRisk(str: string): boolean {
  let i = 0;
  while (i < str.length && str.charCodeAt(i) === 0x20) i++;
  if (i >= str.length) return false;
  return FORMULA_TRIGGER_CHARS.has(str[i]);
}

/**
 * Escape a single CSV cell value, including formula-injection prefixes and
 * standard CSV quoting for commas, quotes, and newlines.
 *
 * Numeric values (`typeof value === "number"`) are always rendered as plain
 * numbers and never subjected to the formula-injection guard: a negative
 * number like `-12.34` must round-trip as `-12.34`, not `"'-12.34"` — only a
 * *string* that happens to look like a negative number (e.g. the literal
 * text `"-12"`) is guarded, since spreadsheet apps only ever interpret
 * *text* cells as formulas.
 */
export function escapeCSVValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const str = typeof value === "string" ? value : String(value);
  if (hasFormulaInjectionRisk(str)) {
    return `"'${str.replace(/"/g, '""')}"`;
  }
  // RFC4180: quote any field containing a comma, a double quote, an
  // embedded LF, or a bare CR (a lone CR — not part of a formula-prefix
  // check above — still breaks naive line-based CSV parsing unless quoted).
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of objects to a CSV string.
 */
export function arrayToCSV(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  columns: CSVColumn[],
  metadata?: ExportMetadata,
): string {
  const lines: string[] = [];

  // Metadata header rows (Label,Value format)
  if (metadata) {
    lines.push(`Report,${escapeCSVValue(metadata.reportName)}`);
    if (metadata.dateRange) {
      lines.push(`Date Range,${escapeCSVValue(metadata.dateRange)}`);
    }
    if (metadata.teams) {
      lines.push(`Teams,${escapeCSVValue(metadata.teams)}`);
    }
    if (metadata.orgs) {
      lines.push(`Organizations,${escapeCSVValue(metadata.orgs)}`);
    }
    lines.push(
      `Exported At,${escapeCSVValue(new Date().toLocaleString())}`,
    );
    lines.push(""); // blank separator line
  }

  // Header row
  lines.push(columns.map((col) => escapeCSVValue(col.label)).join(","));

  // Data rows
  for (const row of rows) {
    const values = columns.map((col) => {
      if (col.format) return escapeCSVValue(col.format(row));
      return escapeCSVValue(row[col.key]);
    });
    lines.push(values.join(","));
  }

  return lines.join("\n");
}

const API_MAX_PAGE_SIZE = 200;

/**
 * Fetch all pages from a paginated API endpoint.
 * Loops through pages (API caps at 200 per page) until all data is collected.
 */
export async function fetchAllPages(
  fetchUrl: string,
  extraParams: URLSearchParams,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dataExtractor: (json: any) => any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const params = new URLSearchParams(extraParams.toString());
  params.set("pageSize", String(API_MAX_PAGE_SIZE));
  params.set("page", "1");

  // First page — get total
  const firstRes = await fetch(`${fetchUrl}?${params.toString()}`);
  if (!firstRes.ok) throw new Error(`Export fetch failed: HTTP ${firstRes.status}`);
  const firstJson = await firstRes.json();
  const firstData = dataExtractor(firstJson);
  if (!Array.isArray(firstData)) {
    throw new Error("Export failed: API returned invalid data format");
  }
  const totalPages: number = firstJson.pagination?.totalPages ?? 1;

  if (totalPages <= 1) return firstData;

  // Fetch remaining pages (batched 3 at a time)
  const allData = [...firstData];
  const BATCH_SIZE = 3;

  for (let batch = 2; batch <= totalPages; batch += BATCH_SIZE) {
    const pageNums = Array.from(
      { length: Math.min(BATCH_SIZE, totalPages - batch + 1) },
      (_, i) => batch + i,
    );

    const results = await Promise.all(
      pageNums.map(async (pageNum) => {
        const p = new URLSearchParams(params.toString());
        p.set("page", String(pageNum));
        const res = await fetch(`${fetchUrl}?${p.toString()}`);
        if (!res.ok) throw new Error(`Export fetch failed: HTTP ${res.status} (page ${pageNum})`);
        const json = await res.json();
        const extracted = dataExtractor(json);
        if (!Array.isArray(extracted)) {
          throw new Error(`Export failed: API returned invalid data format (page ${pageNum})`);
        }
        return extracted;
      }),
    );

    for (const rows of results) {
      allData.push(...rows);
    }
  }

  return allData;
}
