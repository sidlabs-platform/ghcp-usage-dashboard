import { describe, it, expect, vi, beforeEach } from "vitest";
import { arrayToCSV, fetchAllPages, type CSVColumn, type ExportMetadata } from "./csv";

// ── escapeCSVValue (tested indirectly through arrayToCSV) ─────────────

describe("CSV formula injection prevention", () => {
  const col: CSVColumn[] = [{ key: "val", label: "Value" }];

  it("escapes values starting with =", () => {
    const csv = arrayToCSV([{ val: "=SUM(A1)" }], col);
    expect(csv).toContain(`"'=SUM(A1)"`);
  });

  it("escapes values starting with +", () => {
    const csv = arrayToCSV([{ val: "+cmd" }], col);
    expect(csv).toContain(`"'+cmd"`);
  });

  it("escapes values starting with -", () => {
    const csv = arrayToCSV([{ val: "-1+2" }], col);
    expect(csv).toContain(`"'-1+2"`);
  });

  it("escapes values starting with @", () => {
    const csv = arrayToCSV([{ val: "@user" }], col);
    expect(csv).toContain(`"'@user"`);
  });

  it("escapes values starting with |", () => {
    const csv = arrayToCSV([{ val: "|pipe" }], col);
    expect(csv).toContain(`"'|pipe"`);
  });

  it("escapes values starting with %", () => {
    const csv = arrayToCSV([{ val: "%env" }], col);
    expect(csv).toContain(`"'%env"`);
  });

  it("escapes values starting with tab", () => {
    const csv = arrayToCSV([{ val: "\tindented" }], col);
    expect(csv).toContain(`"'\tindented"`);
  });

  it("escapes values starting with \\r", () => {
    const csv = arrayToCSV([{ val: "\rcarriage" }], col);
    expect(csv).toContain(`"'\rcarriage"`);
  });

  it("does not escape normal values", () => {
    const csv = arrayToCSV([{ val: "hello" }], col);
    const lines = csv.split("\n");
    expect(lines[lines.length - 1]).toBe("hello");
  });

  it("handles null and undefined values", () => {
    const csv = arrayToCSV([{ val: null }, { val: undefined }], col);
    const lines = csv.split("\n");
    expect(lines[lines.length - 2]).toBe("");
    expect(lines[lines.length - 1]).toBe("");
  });
});

// ── arrayToCSV ────────────────────────────────────────────────────────

describe("arrayToCSV", () => {
  const columns: CSVColumn[] = [
    { key: "name", label: "Name" },
    { key: "count", label: "Count" },
  ];

  it("generates header row from column labels", () => {
    const csv = arrayToCSV([], columns);
    expect(csv).toBe("Name,Count");
  });

  it("generates data rows from objects", () => {
    const rows = [
      { name: "Alice", count: 10 },
      { name: "Bob", count: 20 },
    ];
    const csv = arrayToCSV(rows, columns);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Name,Count");
    expect(lines[1]).toBe("Alice,10");
    expect(lines[2]).toBe("Bob,20");
  });

  it("uses custom format function when provided", () => {
    const cols: CSVColumn[] = [
      { key: "name", label: "Name" },
      { key: "rate", label: "Rate", format: (row) => `${row.rate.toFixed(2)}%` },
    ];
    const csv = arrayToCSV([{ name: "Test", rate: 75.5 }], cols);
    const lines = csv.split("\n");
    expect(lines[1]).toBe("Test,75.50%");
  });

  it("quotes values containing commas", () => {
    const csv = arrayToCSV([{ name: "Last, First", count: 1 }], columns);
    expect(csv).toContain('"Last, First"');
  });

  it("quotes values containing double quotes and escapes them", () => {
    const csv = arrayToCSV([{ name: 'Say "hello"', count: 1 }], columns);
    expect(csv).toContain('"Say ""hello"""');
  });

  it("quotes values containing newlines", () => {
    const csv = arrayToCSV([{ name: "line1\nline2", count: 1 }], columns);
    expect(csv).toContain('"line1\nline2"');
  });

  it("includes metadata header when provided", () => {
    const metadata: ExportMetadata = {
      reportName: "Test Report",
      dateRange: "2024-01-01 to 2024-01-31",
      teams: "Team A",
      orgs: "Org1",
    };
    const csv = arrayToCSV([{ name: "Alice", count: 1 }], columns, metadata);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Report,Test Report");
    expect(lines[1]).toBe("Date Range,2024-01-01 to 2024-01-31");
    expect(lines[2]).toBe("Teams,Team A");
    expect(lines[3]).toBe("Organizations,Org1");
    expect(lines[4]).toContain("Exported At,");
    expect(lines[5]).toBe(""); // blank separator
    expect(lines[6]).toBe("Name,Count"); // header row
    expect(lines[7]).toBe("Alice,1"); // data row
  });

  it("metadata formula injection: report name starting with = is escaped", () => {
    const metadata: ExportMetadata = { reportName: "=HYPERLINK(...)" };
    const csv = arrayToCSV([], columns, metadata);
    expect(csv).toContain(`Report,"'=HYPERLINK(...)"`);
  });
});

// ── fetchAllPages ─────────────────────────────────────────────────────

describe("fetchAllPages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches single page of data", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 1 }, { id: 2 }], pagination: { totalPages: 1 } }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const result = await fetchAllPages("/api/test", new URLSearchParams(), (json) => json.data);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches multiple pages", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 1 }], pagination: { totalPages: 2 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 2 }], pagination: { totalPages: 2 } }),
      });
    vi.stubGlobal("fetch", mockFetch);
    const result = await fetchAllPages("/api/test", new URLSearchParams(), (json) => json.data);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchAllPages("/api/test", new URLSearchParams(), (j) => j.data)).rejects.toThrow("HTTP 500");
  });

  it("throws when dataExtractor returns non-array on first page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: "not-array", pagination: { totalPages: 1 } }),
    }));
    await expect(fetchAllPages("/api/test", new URLSearchParams(), (j) => j.data)).rejects.toThrow("invalid data format");
  });

  it("throws when dataExtractor returns non-array on subsequent page", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 1 }], pagination: { totalPages: 2 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: "bad" }),
      });
    vi.stubGlobal("fetch", mockFetch);
    await expect(fetchAllPages("/api/test", new URLSearchParams(), (j) => j.data)).rejects.toThrow("invalid data format (page 2)");
  });

  it("defaults to 1 page when pagination is missing from response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 1 }] }),
    }));
    const result = await fetchAllPages("/api/test", new URLSearchParams(), (j) => j.data);
    expect(result).toEqual([{ id: 1 }]);
  });

  it("throws on non-ok response for subsequent pages", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 1 }], pagination: { totalPages: 2 } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 502 });
    vi.stubGlobal("fetch", mockFetch);
    await expect(fetchAllPages("/api/test", new URLSearchParams(), (j) => j.data)).rejects.toThrow("HTTP 502 (page 2)");
  });
});
