// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

type DateState = {
  mode: "preset" | "custom" | "month";
  days: number;
  startDate: string;
  endDate: string;
  period: string | null;
};

const dateState = vi.hoisted(() => ({
  value: {
    mode: "preset",
    days: 7,
    startDate: "2026-06-02",
    endDate: "2026-06-08",
    period: null,
  } as DateState,
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => dateState.value,
}));

import { useDateRangeParams } from "./useDateRangeParams";

function run() {
  return renderHook(() => useDateRangeParams()).result.current;
}

describe("useDateRangeParams", () => {
  it("sends a rolling preset as `days`, never as frozen bounds", () => {
    dateState.value = {
      mode: "preset",
      days: 28,
      startDate: "2026-05-12",
      endDate: "2026-06-08",
      period: null,
    };

    const { dateParams, dateLabel, filenameSuffix } = run();

    expect(dateParams).toEqual({ days: "28" });
    expect(dateLabel).toBe("Last 28 days");
    expect(filenameSuffix).toBe("28d");
  });

  it("sends a month as explicit bounds, not as a day count", () => {
    dateState.value = {
      mode: "month",
      days: 31,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      period: "2026-03",
    };

    const { dateParams, filenameSuffix, period } = run();

    // The whole point: forwarding `days: 31` here would ask the API for "the
    // last 31 days ending yesterday", which is a different window entirely.
    expect(dateParams).toEqual({ startDate: "2026-03-01", endDate: "2026-03-31" });
    expect(dateParams).not.toHaveProperty("days");
    expect(filenameSuffix).toBe("2026-03");
    expect(period).toBe("2026-03");
  });

  it("sends a custom range as explicit bounds", () => {
    dateState.value = {
      mode: "custom",
      days: 15,
      startDate: "2026-02-01",
      endDate: "2026-02-15",
      period: null,
    };

    const { dateParams, dateLabel, filenameSuffix } = run();

    expect(dateParams).toEqual({ startDate: "2026-02-01", endDate: "2026-02-15" });
    expect(dateLabel).toBe("2026-02-01 to 2026-02-15");
    expect(filenameSuffix).toBe("2026-02-01_2026-02-15");
  });

  it("falls back to `days` when a non-preset mode has no resolved bounds", () => {
    dateState.value = { mode: "custom", days: 7, startDate: "", endDate: "", period: null };

    expect(run().dateParams).toEqual({ days: "7" });
  });

  it("uses the singular day label for a one-day window", () => {
    dateState.value = {
      mode: "preset",
      days: 1,
      startDate: "2026-06-08",
      endDate: "2026-06-08",
      period: null,
    };

    expect(run().dateLabel).toBe("Last 1 day");
  });

  it("merges extra params over the date params and returns a fresh object each call", () => {
    dateState.value = {
      mode: "month",
      days: 31,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      period: "2026-03",
    };

    const { buildParams } = run();
    const first = buildParams({ teams: "eng" });
    first.set("page", "3");
    const second = buildParams(new URLSearchParams("orgs=acme"));

    expect(first.get("teams")).toBe("eng");
    expect(second.get("orgs")).toBe("acme");
    // A shared instance would leak `page=3` into every later request.
    expect(second.get("page")).toBeNull();
    expect(second.get("startDate")).toBe("2026-03-01");
  });

  it("keeps a caller-supplied override rather than the date param", () => {
    dateState.value = {
      mode: "preset",
      days: 7,
      startDate: "2026-06-02",
      endDate: "2026-06-08",
      period: null,
    };

    expect(run().buildParams({ days: "90" }).get("days")).toBe("90");
  });
});
