import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DAYS } from "@/lib/utils";
import { resolveBillingWindow } from "./billing-window";

describe("resolveBillingWindow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("honours explicit startDate/endDate bounds and reports their inclusive span", () => {
    const result = resolveBillingWindow(
      new URLSearchParams({ startDate: "2026-03-01", endDate: "2026-03-31", days: "7" }),
    );

    expect(result).toEqual({ start: "2026-03-01", end: "2026-03-31", days: 31, period: null });
  });

  it("keeps period as the highest-precedence selector over explicit bounds", () => {
    const result = resolveBillingWindow(
      new URLSearchParams({
        period: "2026-03",
        startDate: "2020-01-01",
        endDate: "2020-01-31",
        days: "7",
      }),
    );

    expect(result).toEqual({ start: "2026-03-01", end: "2026-03-31", days: 31, period: "2026-03" });
  });

  it("rejects a half-filled explicit date range", () => {
    expect(resolveBillingWindow(new URLSearchParams({ startDate: "2026-03-01" }))).toEqual({
      error: "Both startDate and endDate must be provided together.",
    });
  });

  it("rejects empty explicit date range values instead of falling back to days", () => {
    expect(resolveBillingWindow(new URLSearchParams("startDate=&endDate=&days=7"))).toEqual({
      error: "Both startDate and endDate must be provided together.",
    });
  });

  it("rejects a single empty explicit date range boundary", () => {
    expect(resolveBillingWindow(new URLSearchParams({ startDate: "", endDate: "2026-03-31" }))).toEqual({
      error: "Both startDate and endDate must be provided together.",
    });
  });

  it("rejects malformed explicit dates", () => {
    expect(
      resolveBillingWindow(new URLSearchParams({ startDate: "03/01/2026", endDate: "2026-03-31" })),
    ).toEqual({
      error: "startDate and endDate must be in YYYY-MM-DD format.",
    });
  });

  it("rejects regex-valid but impossible explicit calendar dates", () => {
    for (const date of ["2026-02-29", "2026-04-31"]) {
      expect(resolveBillingWindow(new URLSearchParams({ startDate: date, endDate: "2026-05-01" }))).toEqual({
        error: "startDate or endDate is not a valid date.",
      });
      expect(resolveBillingWindow(new URLSearchParams({ startDate: "2026-01-01", endDate: date }))).toEqual({
        error: "startDate or endDate is not a valid date.",
      });
    }
  });

  it("rejects an inverted explicit date range", () => {
    expect(
      resolveBillingWindow(new URLSearchParams({ startDate: "2026-04-01", endDate: "2026-03-31" })),
    ).toEqual({
      error: "startDate must be on or before endDate.",
    });
  });

  it("rejects explicit date ranges spanning more than MAX_DAYS", () => {
    expect(
      resolveBillingWindow(new URLSearchParams({ startDate: "2025-01-01", endDate: "2026-01-01" })),
    ).toEqual({
      error: `Date range spans ${MAX_DAYS + 1} days, which exceeds the maximum of ${MAX_DAYS}.`,
    });
  });

  it("rejects explicit billing windows ending after the current UTC date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));

    expect(resolveBillingWindow(new URLSearchParams({ startDate: "2026-08-01", endDate: "2026-08-22" }))).toEqual({
      error: "endDate cannot be in the future.",
    });
  });

  it("preserves empty period as an error instead of falling back", () => {
    expect(resolveBillingWindow(new URLSearchParams("period=&startDate=2026-03-01&endDate=2026-03-31"))).toEqual({
      error: 'Invalid period "": expected format YYYY-MM',
    });
  });
});
