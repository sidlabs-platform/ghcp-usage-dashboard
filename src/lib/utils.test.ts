import { describe, it, expect } from "vitest";
import { cn, formatNumber, formatPercent, formatDelta, formatMinutes, safeNum, getDateRange, datesBetween, parseAndClampDays, MAX_DAYS } from "./utils";

// ── cn ──────────────────────────────────────────────────────────────────

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("handles conditional classes", () => {
    expect(cn("base", false && "hidden", "text-sm")).toBe("base text-sm");
  });
});

// ── safeNum ──────────────────────────────────────────────────────────────

describe("safeNum", () => {
  it("returns value when valid number", () => {
    expect(safeNum(42)).toBe(42);
  });

  it("returns fallback for null/undefined/NaN", () => {
    expect(safeNum(null)).toBe(0);
    expect(safeNum(undefined)).toBe(0);
    expect(safeNum(NaN)).toBe(0);
  });

  it("uses custom fallback", () => {
    expect(safeNum(null, -1)).toBe(-1);
  });
});

// ── formatNumber ──────────────────────────────────────────────────────

describe("formatNumber", () => {
  it("formats millions with M suffix", () => {
    expect(formatNumber(1_000_000)).toBe("1.0M");
    expect(formatNumber(2_500_000)).toBe("2.5M");
    expect(formatNumber(10_300_000)).toBe("10.3M");
  });

  it("formats thousands with K suffix", () => {
    expect(formatNumber(1_000)).toBe("1.0K");
    expect(formatNumber(1_500)).toBe("1.5K");
    expect(formatNumber(999_999)).toBe("1000.0K");
  });

  it("formats small numbers with locale string", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(42)).toBe("42");
  });

  it("returns '0' for null/undefined/NaN inputs", () => {
    expect(formatNumber(null as any)).toBe("0");
    expect(formatNumber(undefined as any)).toBe("0");
    expect(formatNumber(NaN)).toBe("0");
  });
});

// ── formatPercent ─────────────────────────────────────────────────────

describe("formatPercent", () => {
  it("formats with default 1 decimal", () => {
    expect(formatPercent(50)).toBe("50.0%");
    expect(formatPercent(33.333)).toBe("33.3%");
  });

  it("formats with custom decimals", () => {
    expect(formatPercent(66.6667, 2)).toBe("66.67%");
    expect(formatPercent(100, 0)).toBe("100%");
  });

  it("returns '0%' for null/NaN", () => {
    expect(formatPercent(null as any)).toBe("0%");
    expect(formatPercent(NaN)).toBe("0%");
  });
});

// ── formatDelta ───────────────────────────────────────────────────────

describe("formatDelta", () => {
  it("calculates positive delta", () => {
    const result = formatDelta(150, 100);
    expect(result.value).toBe("+50.0%");
    expect(result.positive).toBe(true);
  });

  it("calculates negative delta", () => {
    const result = formatDelta(50, 100);
    expect(result.value).toBe("-50.0%");
    expect(result.positive).toBe(false);
  });

  it("returns N/A when previous is 0", () => {
    const result = formatDelta(100, 0);
    expect(result.value).toBe("N/A");
    expect(result.positive).toBe(true);
  });

  it("returns N/A for null/NaN inputs", () => {
    expect(formatDelta(null as any, 100).value).toBe("N/A");
    expect(formatDelta(100, null as any).value).toBe("N/A");
  });

  it("handles no change", () => {
    const result = formatDelta(100, 100);
    expect(result.value).toBe("+0.0%");
    expect(result.positive).toBe(true);
  });
});

// ── formatMinutes ─────────────────────────────────────────────────────

describe("formatMinutes", () => {
  it("formats minutes under 60 as Xm", () => {
    expect(formatMinutes(30)).toBe("30m");
    expect(formatMinutes(59)).toBe("59m");
  });

  it("formats minutes under 1440 as Xh", () => {
    expect(formatMinutes(60)).toBe("1.0h");
    expect(formatMinutes(90)).toBe("1.5h");
    expect(formatMinutes(1439)).toBe("24.0h");
  });

  it("formats minutes >= 1440 as Xd", () => {
    expect(formatMinutes(1440)).toBe("1.0d");
    expect(formatMinutes(2880)).toBe("2.0d");
  });

  it("returns '0m' for null/NaN", () => {
    expect(formatMinutes(null as any)).toBe("0m");
    expect(formatMinutes(NaN)).toBe("0m");
  });
});

// ── parseAndClampDays ─────────────────────────────────────────────────

describe("parseAndClampDays", () => {
  it("returns default value when raw is null", () => {
    const result = parseAndClampDays(null, 7);
    expect(result).toEqual({ days: 7 });
  });

  it("returns default value of 7 when no default specified and raw is null", () => {
    const result = parseAndClampDays(null);
    expect(result).toEqual({ days: 7 });
  });

  it("parses valid days string", () => {
    expect(parseAndClampDays("14")).toEqual({ days: 14 });
    expect(parseAndClampDays("1")).toEqual({ days: 1 });
    expect(parseAndClampDays("365")).toEqual({ days: 365 });
  });

  it("floors decimal values", () => {
    expect(parseAndClampDays("7.9")).toEqual({ days: 7 });
  });

  it("returns error for values exceeding MAX_DAYS", () => {
    const result = parseAndClampDays("366");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("366");
      expect(result.error).toContain(String(MAX_DAYS));
    }
  });

  it("returns error for very large values", () => {
    const result = parseAndClampDays("99999");
    expect("error" in result).toBe(true);
  });

  it("returns error for zero", () => {
    const result = parseAndClampDays("0");
    expect("error" in result).toBe(true);
  });

  it("returns error for negative values", () => {
    const result = parseAndClampDays("-5");
    expect("error" in result).toBe(true);
  });

  it("returns error for non-numeric strings", () => {
    const result = parseAndClampDays("abc");
    expect("error" in result).toBe(true);
  });

  it("returns error for empty string", () => {
    const result = parseAndClampDays("");
    expect("error" in result).toBe(true);
  });

  it("accepts boundary value of MAX_DAYS", () => {
    expect(parseAndClampDays(String(MAX_DAYS))).toEqual({ days: MAX_DAYS });
  });

  it("uses custom default value", () => {
    expect(parseAndClampDays(null, 28)).toEqual({ days: 28 });
  });
});

// ── getDateRange ──────────────────────────────────────────────────────

describe("getDateRange", () => {
  it("returns start and end dates as YYYY-MM-DD strings", () => {
    const { start, end } = getDateRange(7);
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("end date is yesterday", () => {
    const { end } = getDateRange(7);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(end).toBe(yesterday.toISOString().split("T")[0]);
  });

  it("span between start and end is days-1", () => {
    const { start, end } = getDateRange(7);
    const s = new Date(start);
    const e = new Date(end);
    const diff = (e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24);
    expect(diff).toBe(6); // 7 days span = 6-day difference
  });

  it("handles 1-day range (start === end)", () => {
    const { start, end } = getDateRange(1);
    expect(start).toBe(end);
  });
});

// ── datesBetween ──────────────────────────────────────────────────────

describe("datesBetween", () => {
  it("returns all dates between start and end inclusive", () => {
    const result = datesBetween("2024-01-01", "2024-01-03");
    expect(result).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
  });

  it("returns single date when start === end", () => {
    expect(datesBetween("2024-06-15", "2024-06-15")).toEqual(["2024-06-15"]);
  });

  it("returns empty array when start > end", () => {
    expect(datesBetween("2024-01-05", "2024-01-01")).toEqual([]);
  });

  it("handles month boundaries", () => {
    const result = datesBetween("2024-01-30", "2024-02-02");
    expect(result).toEqual(["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"]);
  });

  it("handles leap year", () => {
    const result = datesBetween("2024-02-28", "2024-03-01");
    expect(result).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });
});
