import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("leaves a deliberately earlier end date untouched", () => {
    const result = parseSeatLifecycleWindow(
      new URLSearchParams({ startDate: shiftDays(-10), endDate: shiftDays(-2) }),
    );
    expect(result).toMatchObject({ end: shiftDays(-2) });
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
