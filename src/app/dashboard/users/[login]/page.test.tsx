// @vitest-environment jsdom
//
// Proves the user detail dashboard page's daily LoC chart and summary cards
// agree on "LoC Suggested" and "LoC Accepted (Completions)": all three must be
// built from the strict server-computed completionLocSuggested/
// completionLocAccepted fields (IS_COMPLETION_SQL allowlist), never from the
// top-level locSuggested/locAccepted fields (which still include
// copilot_app/chat_inline/unknown activity, and locAccepted minus
// agentLocAdded specifically, and would let the chart diverge from the cards).
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
      // Top-level locSuggested includes completion (400) + copilot_app/chat_inline/
      // unknown suggested LoC (100 extra). If the chart plotted this field directly,
      // it would show 500 instead of the correct completion-only 400.
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
      completionLocSuggested: 400,
      completionLocAccepted: 300,
      completionLocDeleted: 15,
      // Top-level locSuggestedDelete (10) includes copilot_app/chat_inline/
      // unknown/agent_edit suggested-deletion activity too; the strict
      // completion-only value is smaller (6), so the chart must plot this
      // field, not locSuggestedDelete.
      completionLocSuggestedDelete: 6,
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
    totalLocSuggested: 400,
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

  it("uses the same strict completionLocSuggested/completionLocAccepted/completionLocDeleted for both the daily chart and the summary card", async () => {
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

    // Card: summary.totalLocSuggested / completionLocAccepted / completionLocDeleted (strict, server-side).
    expect(screen.getByTestId("metric-LoC Suggested")).toHaveTextContent("400");
    expect(screen.getByTestId("metric-LoC Accepted")).toHaveTextContent("300");
    expect(screen.getByTestId("metric-LoC Deleted")).toHaveTextContent("15");

    // Chart: must plot the SAME strict per-day values — not the top-level
    // locSuggested (500, which wrongly includes 100 LoC of copilot_app/
    // chat_inline/unknown suggested activity), and not
    // Math.max(0, locAccepted - agentLocAdded) (which would be 450, wrongly
    // including the day's 150 copilot_app LoC).
    expect(chartState.areaDataByKey.completionLocSuggested).toEqual([400]);
    expect(chartState.areaDataByKey.completionLocAccepted).toEqual([300]);
    expect(chartState.areaDataByKey.completionLocDeleted).toEqual([15]);

    // The chart must plot the strict completion-only suggested-delete value
    // (6), not the top-level locSuggestedDelete (10) which includes
    // copilot_app/chat_inline/unknown/agent_edit suggested-deletion activity.
    expect(chartState.areaDataByKey.completionLocSuggestedDelete).toEqual([6]);
    expect(chartState.areaDataByKey.locSuggestedDelete).toBeUndefined();

    // The chart must never key off the raw top-level locSuggested field.
    expect(chartState.areaDataByKey.locSuggested).toBeUndefined();

    // Card and chart must agree exactly.
    expect(chartState.areaDataByKey.completionLocSuggested![0]).toBe(apiResponse.summary.totalLocSuggested);
    expect(chartState.areaDataByKey.completionLocAccepted![0]).toBe(apiResponse.summary.completionLocAccepted);
    expect(chartState.areaDataByKey.completionLocDeleted![0]).toBe(apiResponse.summary.completionLocDeleted);
  });
});
