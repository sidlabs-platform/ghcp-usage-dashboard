// @vitest-environment jsdom
//
// Proves the user detail dashboard page's daily LoC chart and summary card
// agree on "LoC Accepted (Completions)": both must be built from the strict
// server-computed completionLocAccepted field (IS_COMPLETION_SQL allowlist),
// never from top-level locAccepted minus agentLocAdded (which still includes
// copilot_app/chat_inline/unknown activity and would let the chart diverge
// from the card).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const chartState = vi.hoisted(() => ({
  areaDataByKey: {} as Record<string, unknown[]>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ login: "octocat" }),
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => ({ mode: "preset", days: 7, startDate: "", endDate: "" }),
}));

vi.mock("@/components/layout/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock("@/components/filters/DateFilter", () => ({
  DateFilter: () => <div>Date Filter</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/cards/MetricCard", () => ({
  MetricCard: ({ title, value }: { title: string; value: React.ReactNode }) => (
    <section>
      <h3>{title}</h3>
      <span data-testid={`metric-${title}`}>{value}</span>
    </section>
  ),
}));

// Mock recharts: AreaChart just captures its `data` prop (keyed by the
// dataKey of each child Area) so the test can assert on values directly,
// without needing to introspect rendered SVG.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ data, children }: { data: Record<string, unknown>[]; children: React.ReactNode }) => {
    for (const child of React.Children.toArray(children) as React.ReactElement<{ dataKey?: string }>[]) {
      const dataKey = child?.props?.dataKey;
      if (typeof dataKey === "string") {
        chartState.areaDataByKey[dataKey] = data.map((d) => d[dataKey]);
      }
    }
    return <div data-testid="area-chart" />;
  },
  Area: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
}));

const apiResponse = {
  user: "octocat",
  dailyActivity: [
    {
      day: "2024-01-01",
      codeGen: 100,
      codeAccept: 80,
      locSuggested: 500,
      // Top-level locAccepted includes completion (300) + agent (100) + copilot_app (150).
      // If the chart subtracted only agentLocAdded, it would show 450 (300 + 150) —
      // wrongly including the App's 150 LoC — instead of the correct 300.
      locAccepted: 550,
      locSuggestedDelete: 10,
      locDeleted: 60,
      interactions: 40,
      aiCreditsUsed: 2,
      agentLocAdded: 100,
      agentLocDeleted: 20,
      completionLocAccepted: 300,
      completionLocDeleted: 15,
      appLocAdded: 150,
      appLocDeleted: 25,
    },
  ],
  summary: {
    totalActiveDays: 1,
    totalLocAdded: 500,
    totalLocAccepted: 550,
    totalLocSuggestedDelete: 10,
    totalLocDeleted: 60,
    totalInteractions: 40,
    totalAiCreditsUsed: 2,
    totalCodeGen: 100,
    totalCodeAccept: 80,
    acceptanceRate: 80,
    agentLocAdded: 100,
    agentLocDeleted: 20,
    totalLocSuggested: 300,
    completionLocAccepted: 300,
    completionLocDeleted: 15,
    completionAcceptanceRate: 75,
    usedAgent: true,
    usedChat: false,
    usedCli: false,
    usedCodeReview: false,
    usedCodingAgent: false,
    usedCodeReviewPassive: false,
  },
  topLanguages: [],
  topModels: [],
  ideUsage: [],
  featureUsage: [],
  chatModes: { agent: 0, ask: 0, edit: 0, plan: 0, custom: 0, unknown: 0 },
  cliStats: null,
};

describe("user detail page — LoC chart/card consistency", () => {
  afterEach(() => {
    cleanup();
    chartState.areaDataByKey = {};
    vi.unstubAllGlobals();
  });

  it("uses the same strict completionLocAccepted/completionLocDeleted for both the daily chart and the summary card", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(apiResponse),
      }),
    ) as unknown as typeof fetch);

    const Page = (await import("./page")).default;
    await act(async () => {
      render(<Page />);
    });

    // Card: summary.completionLocAccepted / completionLocDeleted (strict, server-side).
    expect(screen.getByTestId("metric-LoC Accepted")).toHaveTextContent("300");
    expect(screen.getByTestId("metric-LoC Deleted")).toHaveTextContent("15");

    // Chart: must plot the SAME strict per-day values — not
    // Math.max(0, locAccepted - agentLocAdded) (which would be 450, wrongly
    // including the day's 150 copilot_app LoC).
    expect(chartState.areaDataByKey.completionLocAccepted).toEqual([300]);
    expect(chartState.areaDataByKey.completionLocDeleted).toEqual([15]);

    // Card and chart must agree exactly.
    expect(chartState.areaDataByKey.completionLocAccepted![0]).toBe(apiResponse.summary.completionLocAccepted);
    expect(chartState.areaDataByKey.completionLocDeleted![0]).toBe(apiResponse.summary.completionLocDeleted);
  });
});
