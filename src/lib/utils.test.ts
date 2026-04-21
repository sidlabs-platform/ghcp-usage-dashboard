import { describe, it, expect } from "vitest";
import { formatNumber, formatPercent, formatDelta, formatMinutes, getDateRange, datesBetween } from "./utils";

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
