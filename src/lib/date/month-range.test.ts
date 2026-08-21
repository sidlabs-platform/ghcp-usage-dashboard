import { describe, it, expect } from "vitest";
import {
  isValidPeriod,
  periodOf,
  monthBounds,
  isPartialMonth,
  monthDayCount,
  recentPeriods,
  periodLabel,
  periodLabelShort,
  monthsCoveringRange,
} from "./month-range";

// A fixed "now" mid-month so partial-month clamping is observable.
const NOW = new Date("2026-08-20T11:30:00Z");

describe("isValidPeriod", () => {
  it("accepts well-formed periods", () => {
    expect(isValidPeriod("2026-01")).toBe(true);
    expect(isValidPeriod("2026-12")).toBe(true);
  });

  it("rejects out-of-range months", () => {
    expect(isValidPeriod("2026-00")).toBe(false);
    expect(isValidPeriod("2026-13")).toBe(false);
  });

  it("rejects malformed strings", () => {
    for (const bad of ["2026", "2026-1", "26-01", "2026-01-01", "", "abcd-ef"]) {
      expect(isValidPeriod(bad)).toBe(false);
    }
  });
});

describe("periodOf", () => {
  it("derives the UTC period", () => {
    expect(periodOf(NOW)).toBe("2026-08");
    expect(periodOf(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("uses UTC, not local time, at the month boundary", () => {
    // 23:30 UTC on the last day of July is still July regardless of the
    // machine's timezone; a local-time implementation could report August.
    expect(periodOf(new Date("2026-07-31T23:30:00Z"))).toBe("2026-07");
  });
});

describe("monthBounds", () => {
  it("returns whole-month bounds for a past month", () => {
    expect(monthBounds("2026-07", NOW)).toEqual({ startDate: "2026-07-01", endDate: "2026-07-31" });
  });

  it("handles 30-day months and February", () => {
    expect(monthBounds("2026-06", NOW).endDate).toBe("2026-06-30");
    expect(monthBounds("2026-02", NOW).endDate).toBe("2026-02-28");
  });

  it("handles a leap February", () => {
    expect(monthBounds("2024-02", NOW).endDate).toBe("2024-02-29");
  });

  it("clamps the current month to today so the window never runs into the future", () => {
    expect(monthBounds("2026-08", NOW)).toEqual({ startDate: "2026-08-01", endDate: "2026-08-20" });
  });

  it("collapses a future month to its start rather than emitting end < start", () => {
    const bounds = monthBounds("2026-11", NOW);
    expect(bounds.startDate).toBe("2026-11-01");
    expect(bounds.endDate).toBe("2026-11-01");
    expect(bounds.endDate >= bounds.startDate).toBe(true);
  });

  it("throws on malformed input rather than silently returning a wrong window", () => {
    expect(() => monthBounds("2026", NOW)).toThrow(/YYYY-MM/);
    expect(() => monthBounds("2026-13", NOW)).toThrow(/between 01 and 12/);
  });
});

describe("isPartialMonth", () => {
  it("is true only for the current month", () => {
    expect(isPartialMonth("2026-08", NOW)).toBe(true);
    expect(isPartialMonth("2026-07", NOW)).toBe(false);
    expect(isPartialMonth("2026-09", NOW)).toBe(false);
  });
});

describe("monthDayCount", () => {
  it("counts inclusive days of a complete month", () => {
    expect(monthDayCount("2026-07", NOW)).toBe(31);
    expect(monthDayCount("2026-06", NOW)).toBe(30);
    expect(monthDayCount("2026-02", NOW)).toBe(28);
  });

  it("counts only elapsed days of the current month", () => {
    expect(monthDayCount("2026-08", NOW)).toBe(20);
  });

  it("agrees with the bounds it is derived from", () => {
    for (const period of ["2026-01", "2026-06", "2026-08", "2024-02"]) {
      const { startDate, endDate } = monthBounds(period, NOW);
      const expected = Math.round(
        (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
      ) + 1;
      expect(monthDayCount(period, NOW)).toBe(expected);
    }
  });
});

describe("recentPeriods", () => {
  it("returns the requested count, newest first, including the current month", () => {
    expect(recentPeriods(3, NOW)).toEqual(["2026-08", "2026-07", "2026-06"]);
  });

  it("rolls over the year boundary correctly", () => {
    const jan = new Date("2026-01-15T00:00:00Z");
    expect(recentPeriods(3, jan)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });

  it("produces only valid periods across a long span", () => {
    const periods = recentPeriods(24, NOW);
    expect(periods).toHaveLength(24);
    expect(periods.every(isValidPeriod)).toBe(true);
    expect(new Set(periods).size).toBe(24);
  });

  it("returns an empty list for a non-positive count", () => {
    expect(recentPeriods(0, NOW)).toEqual([]);
  });
});

describe("periodLabel / periodLabelShort", () => {
  it("formats valid periods", () => {
    expect(periodLabel("2026-08")).toBe("August 2026");
    expect(periodLabelShort("2026-08")).toBe("Aug 2026");
    expect(periodLabelShort("2026-09")).toBe("Sep 2026");
  });

  it("passes malformed input through unchanged instead of rendering 'undefined'", () => {
    expect(periodLabel("nonsense")).toBe("nonsense");
    expect(periodLabel("2026-13")).toBe("2026-13");
    expect(periodLabelShort("2026-13")).toBe("2026-13");
  });
});

describe("monthsCoveringRange", () => {
  it("reports a whole month as complete coverage", () => {
    expect(monthsCoveringRange("2026-03-01", "2026-03-31")).toEqual({
      months: ["2026-03"],
      partial: false,
    });
  });

  it("flags a partial month, which month-keyed rows would silently widen", () => {
    expect(monthsCoveringRange("2026-03-15", "2026-03-20")).toEqual({
      months: ["2026-03"],
      partial: true,
    });
  });

  it("expands a range across a year boundary in ascending order", () => {
    expect(monthsCoveringRange("2025-11-10", "2026-02-05")).toEqual({
      months: ["2025-11", "2025-12", "2026-01", "2026-02"],
      partial: true,
    });
  });

  it("treats consecutive whole months as complete coverage", () => {
    expect(monthsCoveringRange("2026-01-01", "2026-02-28")).toEqual({
      months: ["2026-01", "2026-02"],
      partial: false,
    });
  });

  it("uses the real length of the end month, including leap February", () => {
    expect(monthsCoveringRange("2024-02-01", "2024-02-29")?.partial).toBe(false);
    expect(monthsCoveringRange("2026-02-01", "2026-02-28")?.partial).toBe(false);
    expect(monthsCoveringRange("2024-02-01", "2024-02-28")?.partial).toBe(true);
  });

  it("accepts a real leap day without widening it to a different month", () => {
    expect(monthsCoveringRange("2024-02-29", "2024-02-29")).toEqual({
      months: ["2024-02"],
      partial: true,
    });
  });

  it("returns null for malformed or inverted input", () => {
    expect(monthsCoveringRange("2026-03", "2026-03-20")).toBeNull();
    expect(monthsCoveringRange("nonsense", "2026-03-20")).toBeNull();
    expect(monthsCoveringRange("2026-03-20", "2026-03-15")).toBeNull();
    expect(monthsCoveringRange("2026-13-01", "2026-13-28")).toBeNull();
  });

  it("returns null for impossible calendar dates that still match YYYY-MM-DD", () => {
    expect(monthsCoveringRange("2026-02-29", "2026-03-01")).toBeNull();
    expect(monthsCoveringRange("2026-04-01", "2026-04-31")).toBeNull();
    expect(monthsCoveringRange("2026-03-00", "2026-03-20")).toBeNull();
  });
});