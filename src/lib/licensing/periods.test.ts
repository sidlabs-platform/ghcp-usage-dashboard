import { describe, it, expect } from "vitest";
import {
  parseReportMonths,
  cycleBoundsUtc,
  intervalOverlapsPeriod,
  earliestRecoverablePeriod,
} from "./periods";

describe("parseReportMonths", () => {
  it("parses a single month", () => {
    expect(parseReportMonths("2026-01")).toEqual(["2026-01"]);
  });

  it("parses an inclusive range", () => {
    expect(parseReportMonths("2026-01..2026-03")).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });

  it("parses an inclusive range spanning a year boundary", () => {
    expect(parseReportMonths("2025-11..2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("parses an array of months and ranges, de-duplicated and sorted", () => {
    expect(
      parseReportMonths(["2026-03", "2026-01..2026-02", "2026-01"])
    ).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("parses last_N_months relative to now", () => {
    expect(parseReportMonths("last_2_months", new Date("2026-08-07T00:00:00Z"))).toEqual([
      "2026-07",
      "2026-08",
    ]);
  });

  it("parses last_1_months as just the current month", () => {
    expect(parseReportMonths("last_1_months", new Date("2026-08-07T00:00:00Z"))).toEqual([
      "2026-08",
    ]);
  });

  it("parses last_N_months spanning a year boundary", () => {
    expect(parseReportMonths("last_3_months", new Date("2026-01-15T00:00:00Z"))).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("defaults to the current month when input is undefined", () => {
    expect(parseReportMonths(undefined, new Date("2026-08-07T00:00:00Z"))).toEqual([
      "2026-08",
    ]);
  });

  it("throws on malformed month syntax", () => {
    expect(() => parseReportMonths("2026-1")).toThrow();
    expect(() => parseReportMonths("not-a-month")).toThrow();
    expect(() => parseReportMonths("2026-13")).toThrow();
    expect(() => parseReportMonths("2026-00")).toThrow();
  });

  it("throws on malformed range syntax", () => {
    expect(() => parseReportMonths("2026-03..2026-01")).toThrow(); // reversed range
    expect(() => parseReportMonths("2026-01..bad")).toThrow();
  });

  it("throws on malformed last_N_months syntax", () => {
    expect(() => parseReportMonths("last_0_months")).toThrow();
    expect(() => parseReportMonths("last_months")).toThrow();
    expect(() => parseReportMonths("last_-1_months")).toThrow();
  });
});

describe("cycleBoundsUtc", () => {
  it("returns the [start, next-month-start) bounds for a mid-year month", () => {
    const bounds = cycleBoundsUtc("2026-02");
    expect(bounds.start).toBe("2026-02-01T00:00:00.000Z");
    expect(bounds.end).toBe("2026-03-01T00:00:00.000Z");
  });

  it("rolls over correctly at a year boundary", () => {
    const bounds = cycleBoundsUtc("2026-12");
    expect(bounds.start).toBe("2026-12-01T00:00:00.000Z");
    expect(bounds.end).toBe("2027-01-01T00:00:00.000Z");
  });

  it("throws on malformed period", () => {
    expect(() => cycleBoundsUtc("2026-13")).toThrow();
    expect(() => cycleBoundsUtc("bad")).toThrow();
  });
});

describe("intervalOverlapsPeriod", () => {
  it("overlaps when assigned before period and never revoked", () => {
    expect(intervalOverlapsPeriod("2026-01-15", null, "2026-02")).toBe(true);
  });

  it("does not overlap when assigned after the period ends", () => {
    expect(intervalOverlapsPeriod("2026-03-01", null, "2026-02")).toBe(false);
  });

  it("does not overlap when revoked at or before period start (half-open)", () => {
    expect(intervalOverlapsPeriod("2026-01-01", "2026-02-01", "2026-02")).toBe(false);
  });

  it("overlaps when revoked after period start", () => {
    expect(intervalOverlapsPeriod("2026-01-01", "2026-02-01T00:00:00.001Z", "2026-02")).toBe(true);
  });

  it("overlaps when assigned exactly at period start", () => {
    expect(intervalOverlapsPeriod("2026-02-01T00:00:00.000Z", null, "2026-02")).toBe(true);
  });

  it("does not overlap when assigned exactly at period end", () => {
    expect(intervalOverlapsPeriod("2026-03-01T00:00:00.000Z", null, "2026-02")).toBe(false);
  });

  it("treats missing assignedAt as always-started", () => {
    expect(intervalOverlapsPeriod(null, null, "2026-02")).toBe(true);
    expect(intervalOverlapsPeriod(undefined, "2026-01-01", "2026-02")).toBe(false);
  });
});

describe("earliestRecoverablePeriod", () => {
  it("returns the retention-based cutoff when no snapshots/archives exist", () => {
    const result = earliestRecoverablePeriod({
      auditRetentionDays: 60,
      now: new Date("2026-08-07T00:00:00Z"),
    });
    // 60 days back from 2026-08-07 lands in June 2026
    expect(result).toBe("2026-06");
  });

  it("extends further back when snapshots/archives predate the retention cutoff", () => {
    const result = earliestRecoverablePeriod({
      snapshotDates: ["2025-12-01", "2026-01-01"],
      auditRetentionDays: 30,
      now: new Date("2026-08-07T00:00:00Z"),
    });
    expect(result).toBe("2025-12");
  });

  it("uses archive dates the same way as snapshot dates", () => {
    const result = earliestRecoverablePeriod({
      archiveDates: ["2025-10-15"],
      auditRetentionDays: 30,
      now: new Date("2026-08-07T00:00:00Z"),
    });
    expect(result).toBe("2025-10");
  });

  it("returns null when retention is zero/negative and no snapshots exist", () => {
    expect(
      earliestRecoverablePeriod({ auditRetentionDays: 0, now: new Date("2026-08-07T00:00:00Z") })
    ).toBeNull();
  });

  it("ignores retention when snapshots exist even with zero retention", () => {
    const result = earliestRecoverablePeriod({
      snapshotDates: ["2026-05-01"],
      auditRetentionDays: 0,
      now: new Date("2026-08-07T00:00:00Z"),
    });
    expect(result).toBe("2026-05");
  });
});
