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

  it("rejects malformed explicit dates", () => {
    expect(
      resolveBillingWindow(new URLSearchParams({ startDate: "03/01/2026", endDate: "2026-03-31" })),
    ).toEqual({
      error: "startDate and endDate must be in YYYY-MM-DD format.",
    });
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

  it("preserves empty period as an error instead of falling back", () => {
    expect(resolveBillingWindow(new URLSearchParams("period=&startDate=2026-03-01&endDate=2026-03-31"))).toEqual({
      error: 'Invalid period "": expected format YYYY-MM',
    });
  });
});
