import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DAYS } from "@/lib/utils";
import { parseSeatLifecycleWindow, SEAT_LIFECYCLE_DEFAULT_DAYS } from "./seat-lifecycle-window";

function iso(date: Date): string {
  return date.toISOString().split("T")[0];
}

function today(): string {
  return iso(new Date());
}

function shiftDays(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return iso(d);
}

describe("parseSeatLifecycleWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the preset window ending today", () => {
    const result = parseSeatLifecycleWindow(new URLSearchParams());
    expect(result).toMatchObject({ end: today(), explicit: false });
    if ("start" in result) {
      expect(result.start).toBe(shiftDays(-(SEAT_LIFECYCLE_DEFAULT_DAYS - 1)));
    }
  });

  it("honours the app-wide startDate/endDate names", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: "2025-01-01", endDate: "2025-01-31" }),
    );
    expect(result).toEqual({ start: "2025-01-01", end: "2025-01-31", explicit: true });
  });

  it("still honours the legacy start/end names", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ start: "2025-01-01", end: "2025-01-31" }),
    );
    expect(result).toEqual({ start: "2025-01-01", end: "2025-01-31", explicit: true });
  });

  it("prefers startDate/endDate over the legacy names", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({
        startDate: "2025-02-01",
        endDate: "2025-02-28",
        start: "2025-01-01",
        end: "2025-01-31",
      }),
    );
    expect(result).toMatchObject({ start: "2025-02-01", end: "2025-02-28" });
  });

  it("extends an end of yesterday to today", () => {
    // The shared selector resolves presets and an in-progress month to an end
    // of yesterday; without this the page would silently drop today's events.
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(-6), endDate: shiftDays(-1) }),
    );
    expect(result).toMatchObject({ end: today(), explicit: true });
  });

  it("extends an end of today to today", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(-6), endDate: today() }),
    );
    expect(result).toEqual({ start: shiftDays(-6), end: today(), explicit: true });
  });

  it("leaves a fully historical range untouched", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(-10), endDate: shiftDays(-2) }),
    );
    expect(result).toEqual({ start: shiftDays(-10), end: shiftDays(-2), explicit: true });
  });

  it("rejects a range that would become inverted after clamping", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(1), endDate: shiftDays(2) }),
    );
    expect(result).toEqual({ error: "start cannot be in the future." });
  });

  it("rejects a fully future range", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(1), endDate: shiftDays(7) }),
    );
    expect(result).toEqual({ error: "start cannot be in the future." });
  });

  it("rejects a MAX_DAYS raw range ending yesterday because today extension exceeds the limit", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(-MAX_DAYS), endDate: shiftDays(-1) }),
    );

    expect(result).toEqual({
      error: `Date range spans ${MAX_DAYS + 1} days, which exceeds the maximum of ${MAX_DAYS}.`,
    });
  });

  it("accepts a MAX_DAYS effective range after extending an end of yesterday to today", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(-(MAX_DAYS - 1)), endDate: shiftDays(-1) }),
    );

    expect(result).toEqual({ start: shiftDays(-(MAX_DAYS - 1)), end: today(), explicit: true });
  });

  it("rejects a half-filled range", () => {
    expect(parseSeatLifecycleWindow(new URLSearchParams({ startDate: "2025-01-01" }))).toEqual({
      error: "Both start and end must be provided together.",
    });
  });

  it("rejects an inverted range", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: "2025-03-01", endDate: "2025-01-01" }),
    );
    expect("error" in result).toBe(true);
  });

  it("rejects a malformed date", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: "01-01-2025", endDate: "31-01-2025" }),
    );
    expect("error" in result).toBe(true);
  });

  it("rejects a range longer than MAX_DAYS", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: "2023-01-01", endDate: "2025-01-01" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain(String(MAX_DAYS));
  });
});
