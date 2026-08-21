import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSeatActivityWindow } from "./seat-activity-window";

describe("resolveSeatActivityWindow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves current windows ending yesterday unbounded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T06:30:00.000Z"));

    const window = resolveSeatActivityWindow("2026-08-01", "2026-08-20");

    expect(window).toEqual({
      activitySince: "2026-08-01T00:00:00.000Z",
      activityUntil: null,
    });
  });

  it("leaves windows ending today unbounded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T06:30:00.000Z"));

    const window = resolveSeatActivityWindow("2026-08-01", "2026-08-21");

    expect(window).toEqual({
      activitySince: "2026-08-01T00:00:00.000Z",
      activityUntil: null,
    });
  });

  it("bounds fully historical windows at the selected end of day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T06:30:00.000Z"));

    const window = resolveSeatActivityWindow("2026-07-01", "2026-07-31");

    expect(window).toEqual({
      activitySince: "2026-07-01T00:00:00.000Z",
      activityUntil: "2026-07-31T23:59:59.999Z",
    });
  });
});
