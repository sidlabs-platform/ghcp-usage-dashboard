// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoiSection } from "./RoiSection";
import { SALARY_STORAGE_KEY } from "@/lib/roi/salary";
import type { RoiResponse } from "@/lib/types/metrics";

/** Mirrors the compact currency formatting the band buttons render with. */
function formatBand(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 0,
  }).format(amount);
}

function makeResponse(overrides: Partial<RoiResponse> = {}): RoiResponse {
  return {
    hasData: true,
    costSource: "billing",
    currency: "USD",
    creditToUsd: 0.01,
    hasPrData: true,
    windowDays: 28,
    dataAsOf: "2026-05-28",
    daysLoaded: 28,
    filtered: false,
    groups: [
      {
        key: "early",
        label: "Chat & completions",
        phases: [0, 1],
        developers: 100,
        totalCostUsd: 1000,
        costPerDevPerMonth: 10.87,
        prsMerged: 400,
        prsMergedPerDevPerMonth: 4,
      },
      {
        key: "agent",
        label: "Agent-first",
        phases: [2, 3],
        developers: 50,
        totalCostUsd: 2000,
        costPerDevPerMonth: 43.49,
        prsMerged: 500,
        prsMergedPerDevPerMonth: 10,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("RoiSection", () => {
  it("renders both comparison groups with cost and PR metrics", () => {
    render(<RoiSection data={makeResponse()} />);

    expect(screen.getByText("Potential Return on Investment")).toBeInTheDocument();
    expect(screen.getByText("Chat & completions")).toBeInTheDocument();
    expect(screen.getByText("Agent-first")).toBeInTheDocument();

    expect(screen.getByText("100 developers")).toBeInTheDocument();
    expect(screen.getByText("50 developers")).toBeInTheDocument();

    expect(screen.getByText("$10.87")).toBeInTheDocument();
    expect(screen.getByText("$43.49")).toBeInTheDocument();

    expect(screen.getByText("4.0")).toBeInTheDocument();
    expect(screen.getByText("10.0")).toBeInTheDocument();
    expect(screen.getByText("400 merged total")).toBeInTheDocument();
  });

  it("labels the cost basis so estimates are not mistaken for billed spend", () => {
    const { rerender } = render(<RoiSection data={makeResponse()} />);
    expect(screen.getByText("Billed AI Credit spend")).toBeInTheDocument();

    rerender(<RoiSection data={makeResponse({ costSource: "credits" })} />);
    expect(screen.getByText("Estimated from AI credit consumption")).toBeInTheDocument();
  });

  it("renders dashes instead of a misleading $0.00 when there is no cost data", () => {
    const noCost = makeResponse({
      costSource: "none",
      groups: makeResponse().groups.map((g) => ({
        ...g,
        totalCostUsd: 0,
        costPerDevPerMonth: 0,
      })),
    });
    render(<RoiSection data={noCost} />);

    expect(screen.getByText("No cost data")).toBeInTheDocument();
    // Cost/dev/month and % Payroll/month for both groups.
    expect(screen.getAllByText("—")).toHaveLength(4);
    // PR metrics still render.
    expect(screen.getByText("4.0")).toBeInTheDocument();
  });

  it("degrades gracefully when merged PR data is missing from older synced data", () => {
    render(<RoiSection data={makeResponse({ hasPrData: false })} />);

    // One PRs/dev/month dash per group; cost metrics unaffected.
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("$10.87")).toBeInTheDocument();
    expect(screen.queryByText("400 merged total")).not.toBeInTheDocument();
    expect(screen.queryByText(/more pull requests per developer/)).not.toBeInTheDocument();
  });

  it("recalculates payroll percentage when the salary band changes, without a refetch", () => {
    render(<RoiSection data={makeResponse()} />);

    // Default band is 150k -> monthly 12500. 10.87/12500 = 0.09%, 43.49/12500 = 0.35%.
    expect(screen.getByText("0.09%")).toBeInTheDocument();
    expect(screen.getByText("0.35%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: formatBand(100_000) }));

    // 100k -> monthly 8333.33. 10.87/8333.33 = 0.13%, 43.49/8333.33 = 0.52%.
    expect(screen.getByText("0.13%")).toBeInTheDocument();
    expect(screen.getByText("0.52%")).toBeInTheDocument();
    expect(window.localStorage.getItem(SALARY_STORAGE_KEY)).toBe("100000");
  });

  it("restores a previously persisted salary on mount", () => {
    window.localStorage.setItem(SALARY_STORAGE_KEY, "200000");
    render(<RoiSection data={makeResponse()} />);

    // 200k -> monthly 16666.67. 10.87/16666.67 = 0.07%.
    expect(screen.getByText("0.07%")).toBeInTheDocument();
  });

  it("summarizes the delivery lift and the extra spend behind it", () => {
    render(<RoiSection data={makeResponse()} />);

    expect(screen.getByText(/more pull requests per developer/)).toBeInTheDocument();
    expect(screen.getByText("+150%")).toBeInTheDocument();
    expect(screen.getByText("+$32.62")).toBeInTheDocument();
  });

  it("tailors the caveat to the cost source", () => {
    const { unmount } = render(<RoiSection data={makeResponse({ costSource: "billing" })} />);
    expect(screen.getByText(/billed AI Credit spend attributed per developer/)).toBeInTheDocument();
    expect(screen.getByText(/salary band is a modeling input/)).toBeInTheDocument();
    unmount();

    render(<RoiSection data={makeResponse({ costSource: "credits" })} />);
    expect(screen.getByText(/estimated from AI credit consumption/)).toBeInTheDocument();
    expect(screen.getByText(/treat them as directional/)).toBeInTheDocument();
  });
});

