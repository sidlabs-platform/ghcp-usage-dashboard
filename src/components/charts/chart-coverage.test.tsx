// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AcceptanceRateChart } from "@/components/charts/AcceptanceRateChart";
import { ActiveUsersTrendChart } from "@/components/charts/ActiveUsersTrendChart";
import { AgentAdoptionChart } from "@/components/charts/AgentAdoptionChart";
import { AutofixInsightChart } from "@/components/charts/AutofixInsightChart";
import { BillingChargeScopeChart } from "@/components/charts/BillingChargeScopeChart";
import { BillingCostCenterChart } from "@/components/charts/BillingCostCenterChart";
import { BillingCostTrendChart } from "@/components/charts/BillingCostTrendChart";
import { BillingOrgBreakdownChart } from "@/components/charts/BillingOrgBreakdownChart";
import { BillingProductBreakdownChart } from "@/components/charts/BillingProductBreakdownChart";
import { BillingRepoBreakdownChart } from "@/components/charts/BillingRepoBreakdownChart";
import { BillingUserBreakdownChart } from "@/components/charts/BillingUserBreakdownChart";
import { ChatModeDonutChart } from "@/components/charts/ChatModeDonutChart";
import { ChatModeTrendChart } from "@/components/charts/ChatModeTrendChart";
import { CLITokenChart } from "@/components/charts/CLITokenChart";
import { CLIUsersTrendChart } from "@/components/charts/CLIUsersTrendChart";
import { CLIvsIDEChart } from "@/components/charts/CLIvsIDEChart";
import { CohortDistributionChart } from "@/components/charts/CohortDistributionChart";
import { CohortTrendChart } from "@/components/charts/CohortTrendChart";
import {
  CopilotAppAdoptionVolumeChart,
  AdoptionVolumeTooltip,
  formatDate as formatAdoptionVolumeDate,
} from "@/components/charts/CopilotAppAdoptionVolumeChart";
import {
  CopilotAppCodeImpactChart,
  formatDate as formatCodeImpactDate,
} from "@/components/charts/CopilotAppCodeImpactChart";
import { FeatureBreakdownChart } from "@/components/charts/FeatureBreakdownChart";
import { FeatureUsageStackedChart } from "@/components/charts/FeatureUsageStackedChart";
import { LanguageBarChart } from "@/components/charts/LanguageBarChart";
import { LocTrendChart } from "@/components/charts/LocTrendChart";
import { MergeTimeChart } from "@/components/charts/MergeTimeChart";
import { ModelFeatureTable } from "@/components/charts/ModelFeatureTable";
import { ModelTrendChart } from "@/components/charts/ModelTrendChart";
import { ModelUsageBarChart } from "@/components/charts/ModelUsageBarChart";
import { OrgComparisonChart } from "@/components/charts/OrgComparisonChart";
import { PRActivityChart } from "@/components/charts/PRActivityChart";
import { PremiumDailyTrendChart } from "@/components/charts/PremiumDailyTrendChart";
import { PremiumModelUsageChart } from "@/components/charts/PremiumModelUsageChart";
import { PremiumQuotaChart } from "@/components/charts/PremiumQuotaChart";
import { SecurityTrendChart } from "@/components/charts/SecurityTrendChart";
import { SeverityBreakdownChart } from "@/components/charts/SeverityBreakdownChart";
import { Sparkline } from "@/components/charts/Sparkline";
import { CHART_COLORS } from "@/lib/constants";

interface MockChartProps {
  children?: ReactNode;
  data?: unknown;
}

function makeMock(testId: string) {
  const MockChart = ({ children, data }: MockChartProps) => (
    <svg data-testid={testId} data-json={data ? JSON.stringify(data) : undefined}>
      {children}
    </svg>
  );

  MockChart.displayName = testId;

  return MockChart;
}

vi.mock("recharts", () => ({
  ResponsiveContainer: makeMock("ResponsiveContainer"),
  ComposedChart: makeMock("ComposedChart"),
  LineChart: makeMock("LineChart"),
  AreaChart: makeMock("AreaChart"),
  BarChart: makeMock("BarChart"),
  PieChart: makeMock("PieChart"),
  Pie: makeMock("Pie"),
  XAxis: () => null,
  YAxis: () => null,
  Area: ({ dataKey, name, stroke, strokeDasharray, stackId }: { dataKey?: string; name?: string; stroke?: string; strokeDasharray?: string; stackId?: string }) => (
    <span data-testid={`Area-${dataKey}`} data-name={name} data-stroke={stroke} data-stroke-dasharray={strokeDasharray} data-stack-id={stackId} />
  ),
  Line: () => null,
  Bar: () => null,
  Cell: ({ children }: { children?: ReactNode }) => <>{children}</>,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  LabelList: () => null,
}));

afterEach(() => {
  cleanup();
});

describe("chart component coverage", () => {
  const emptySmokeCases = [
    { name: "AcceptanceRateChart", element: <AcceptanceRateChart data={[]} /> },
    { name: "ActiveUsersTrendChart", element: <ActiveUsersTrendChart data={[]} /> },
    { name: "AgentAdoptionChart", element: <AgentAdoptionChart data={[]} /> },
    { name: "BillingCostTrendChart", element: <BillingCostTrendChart data={[]} /> },
    { name: "BillingCostCenterChart", element: <BillingCostCenterChart data={[]} /> },
    { name: "BillingOrgBreakdownChart", element: <BillingOrgBreakdownChart data={[]} /> },
    { name: "BillingProductBreakdownChart", element: <BillingProductBreakdownChart data={[]} /> },
    { name: "BillingRepoBreakdownChart", element: <BillingRepoBreakdownChart data={[]} /> },
    { name: "BillingUserBreakdownChart", element: <BillingUserBreakdownChart data={[]} /> },
    { name: "ChatModeDonutChart", element: <ChatModeDonutChart data={[]} /> },
    { name: "ChatModeTrendChart", element: <ChatModeTrendChart data={[]} /> },
    { name: "CLITokenChart", element: <CLITokenChart data={[]} /> },
    { name: "CLIUsersTrendChart", element: <CLIUsersTrendChart data={[]} /> },
    { name: "CLIvsIDEChart", element: <CLIvsIDEChart data={[]} /> },
    { name: "CohortDistributionChart", element: <CohortDistributionChart data={[]} /> },
    { name: "CohortTrendChart", element: <CohortTrendChart data={[]} /> },
    { name: "CopilotAppAdoptionVolumeChart", element: <CopilotAppAdoptionVolumeChart data={[]} /> },
    { name: "CopilotAppCodeImpactChart", element: <CopilotAppCodeImpactChart data={[]} /> },
    { name: "FeatureBreakdownChart", element: <FeatureBreakdownChart data={[]} /> },
    { name: "FeatureUsageStackedChart", element: <FeatureUsageStackedChart data={[]} /> },
    { name: "LanguageBarChart", element: <LanguageBarChart data={[]} /> },
    { name: "LocTrendChart", element: <LocTrendChart data={[]} /> },
    { name: "MergeTimeChart", element: <MergeTimeChart data={[]} /> },
    { name: "ModelFeatureTable", element: <ModelFeatureTable data={[]} /> },
    { name: "ModelTrendChart", element: <ModelTrendChart data={[]} models={[]} /> },
    { name: "ModelUsageBarChart", element: <ModelUsageBarChart data={[]} /> },
    { name: "OrgComparisonChart", element: <OrgComparisonChart data={[]} /> },
    { name: "PRActivityChart", element: <PRActivityChart data={[]} /> },
    { name: "PremiumDailyTrendChart", element: <PremiumDailyTrendChart data={[]} /> },
    { name: "PremiumModelUsageChart", element: <PremiumModelUsageChart data={[]} /> },
    { name: "PremiumQuotaChart", element: <PremiumQuotaChart data={[]} /> },
    { name: "SecurityTrendChart", element: <SecurityTrendChart title="Security trend" data={[]} /> },
    { name: "SeverityBreakdownChart", element: <SeverityBreakdownChart data={[]} /> },
  ];

  it.each(emptySmokeCases)("$name renders a stable empty-state branch", ({ element }) => {
    const { container } = render(element);
    expect(container.firstChild).not.toBeNull();
  });

  it("LocTrendChart renders a distinct Copilot App added/deleted series", () => {
    render(
      <LocTrendChart
        data={[
          {
            day: "2025-01-01",
            completionSuggested: 100,
            completionAccepted: 80,
            agentAdded: 20,
            agentDeleted: 5,
            appAdded: 30,
            appDeleted: 4,
          },
        ]}
      />,
    );

    const appAddedSeries = screen.getByTestId("Area-appAdded");
    const appDeletedSeries = screen.getByTestId("Area-appDeleted");
    expect(appAddedSeries.getAttribute("data-name")).toBe("App Added");
    expect(appDeletedSeries.getAttribute("data-name")).toBe("App Deleted");

    // App Deleted uses a distinct, accessible/differentiable named color
    // (CHART_COLORS.copilotAppDeleted, not a diluted tint of copilotApp),
    // plus a dashed stroke so it never reads as the same series as App Added.
    expect(appAddedSeries.getAttribute("data-stroke")).toBe(CHART_COLORS.copilotApp);
    expect(appDeletedSeries.getAttribute("data-stroke")).toBe(CHART_COLORS.copilotAppDeleted);
    expect(appDeletedSeries.getAttribute("data-stroke")).not.toBe(appAddedSeries.getAttribute("data-stroke"));
    expect(appDeletedSeries.getAttribute("data-stroke-dasharray")).toBeTruthy();

    const chart = screen.getByTestId("AreaChart");
    expect(chart.getAttribute("data-json")).toContain("\"appAdded\":30");
    expect(chart.getAttribute("data-json")).toContain("\"appDeleted\":4");
  });

  it("LocTrendChart omits App series for legacy data without App metrics", () => {
    render(
      <LocTrendChart
        data={[
          {
            day: "2025-01-01",
            completionSuggested: 100,
            completionAccepted: 80,
            agentAdded: 20,
            agentDeleted: 5,
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("Area-appAdded")).not.toBeInTheDocument();
    expect(screen.queryByTestId("Area-appDeleted")).not.toBeInTheDocument();
  });

  it("CopilotAppAdoptionVolumeChart passes App adoption/volume fields to the chart", () => {
    render(
      <CopilotAppAdoptionVolumeChart
        data={[{ day: "2026-07-29", activeUsers: 12, sessions: 40, requests: 90, prompts: 150 }]}
      />,
    );

    const chart = screen.getByTestId("ComposedChart");
    const plotted = JSON.parse(chart.getAttribute("data-json") ?? "[]") as Array<{
      day: string;
      activeUsers: number;
      sessions: number;
      requests: number;
    }>;
    expect(plotted).toEqual([
      { day: "2026-07-29", activeUsers: 12, sessions: 40, requests: 90, prompts: 150 },
    ]);
  });

  it("AdoptionVolumeTooltip surfaces the prompts value for the hovered day even though prompts isn't a plotted series", () => {
    // Regression test: Recharts' default Tooltip payload only ever contains
    // the plotted series (active users, sessions, requests) for this chart —
    // prompts is intentionally not plotted, so it must be looked up from the
    // original data by day and rendered through the custom tooltip content,
    // not relied upon to appear in `payload`.
    const data = [
      { day: "2026-07-29", activeUsers: 12, sessions: 40, requests: 90, prompts: 150 },
      { day: "2026-07-30", activeUsers: 14, sessions: 45, requests: 95, prompts: 175 },
    ];

    render(
      <AdoptionVolumeTooltip
        active
        label="2026-07-30"
        payload={[
          { name: "Active Users", value: 14, color: "#f97316", dataKey: "activeUsers" },
          { name: "Sessions", value: 45, color: "#3b82f6", dataKey: "sessions" },
          { name: "Requests", value: 95, color: "#8b5cf6", dataKey: "requests" },
        ]}
        data={data}
      />,
    );

    expect(screen.getByText("Prompts")).toBeInTheDocument();
    expect(screen.getByText("175")).toBeInTheDocument();
    // The plotted series still render alongside prompts.
    expect(screen.getByText("Active Users")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
  });

  it("FeatureUsageStackedChart plots a populated Copilot App series with an accessible, distinct legend label", () => {
    render(
      <FeatureUsageStackedChart
        data={[
          { day: "2026-07-29", completions: 100, chat: 20, agent: 5, cli: 3, app: 12 },
        ]}
      />,
    );

    const appSeries = screen.getByTestId("Area-app");
    expect(appSeries.getAttribute("data-name")).toBe("Copilot App");
    // Distinct, named color — not reused from another series — so App is
    // differentiable in both the stacked area chart and its legend.
    expect(appSeries.getAttribute("data-stroke")).toBe(CHART_COLORS.copilotApp);
    expect(appSeries.getAttribute("data-stroke")).not.toBe(CHART_COLORS.completions);
    expect(appSeries.getAttribute("data-stroke")).not.toBe(CHART_COLORS.chat);
    expect(appSeries.getAttribute("data-stroke")).not.toBe(CHART_COLORS.agent);
    expect(appSeries.getAttribute("data-stroke")).not.toBe(CHART_COLORS.cli);

    const chart = screen.getByTestId("AreaChart");
    expect(chart.getAttribute("data-json")).toContain("\"app\":12");
  });

  it("FeatureUsageStackedChart does not stack Copilot App with the other feature series", () => {
    // Regression test: a user can be counted in App and another feature
    // (completions/chat/agent/cli) on the same day, so App must not share a
    // stackId with them — stacking it there would double-count overlapping
    // users and inflate the visible daily total. App gets its own stackId
    // while the other four keep stacking together as before.
    render(
      <FeatureUsageStackedChart
        data={[
          { day: "2026-07-29", completions: 100, chat: 20, agent: 5, cli: 3, app: 12 },
        ]}
      />,
    );

    const completionsSeries = screen.getByTestId("Area-completions");
    const chatSeries = screen.getByTestId("Area-chat");
    const agentSeries = screen.getByTestId("Area-agent");
    const cliSeries = screen.getByTestId("Area-cli");
    const appSeries = screen.getByTestId("Area-app");

    // Existing series behavior is unchanged: they all still share one stack.
    expect(completionsSeries.getAttribute("data-stack-id")).toBe("1");
    expect(chatSeries.getAttribute("data-stack-id")).toBe("1");
    expect(agentSeries.getAttribute("data-stack-id")).toBe("1");
    expect(cliSeries.getAttribute("data-stack-id")).toBe("1");

    // App is unstacked from the rest.
    expect(appSeries.getAttribute("data-stack-id")).not.toBe("1");
    expect(appSeries.getAttribute("data-stack-id")).toBeTruthy();
  });

  it("AdoptionVolumeTooltip renders nothing when inactive or the payload is empty", () => {
    const data = [{ day: "2026-07-29", activeUsers: 12, sessions: 40, requests: 90, prompts: 150 }];

    const inactive = render(<AdoptionVolumeTooltip active={false} label="2026-07-29" payload={[]} data={data} />);
    expect(inactive.container.firstChild).toBeNull();
    inactive.unmount();

    const emptyPayload = render(<AdoptionVolumeTooltip active label="2026-07-29" payload={[]} data={data} />);
    expect(emptyPayload.container.firstChild).toBeNull();
  });

  it("CopilotAppCodeImpactChart passes App code-impact fields to the chart", () => {
    render(
      <CopilotAppCodeImpactChart
        data={[{ day: "2026-07-29", generations: 30, acceptances: 18, locAdded: 200, locDeleted: 25 }]}
      />,
    );

    const chart = screen.getByTestId("ComposedChart");
    const plotted = JSON.parse(chart.getAttribute("data-json") ?? "[]") as Array<{
      day: string;
      generations: number;
      locAdded: number;
    }>;
    expect(plotted).toEqual([
      { day: "2026-07-29", generations: 30, acceptances: 18, locAdded: 200, locDeleted: 25 },
    ]);
  });

  describe("timezone-stable date-axis formatting", () => {
    // Regression test: date-only strings like "2026-07-29" parse as UTC
    // midnight. Formatting via `new Date(dateStr).getMonth()/getDate()` reads
    // those back in the *local* timezone, which rolls back to the prior day
    // for any timezone west of UTC (negative offset). Both Copilot App
    // charts parse the Y/M/D components directly instead, so the displayed
    // date never depends on the host machine's timezone. `process.env.TZ` is
    // restored after each assertion so this doesn't leak into other tests.
    const originalTz = process.env.TZ;

    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it("CopilotAppAdoptionVolumeChart's formatDate is stable west of UTC", () => {
      process.env.TZ = "Pacific/Niue"; // UTC-11
      expect(formatAdoptionVolumeDate("2026-07-29")).toBe("7/29");
    });

    it("CopilotAppAdoptionVolumeChart's formatDate is stable east of UTC", () => {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      expect(formatAdoptionVolumeDate("2026-07-29")).toBe("7/29");
    });

    it("CopilotAppCodeImpactChart's formatDate is stable west of UTC", () => {
      process.env.TZ = "Pacific/Niue"; // UTC-11
      expect(formatCodeImpactDate("2026-07-29")).toBe("7/29");
    });

    it("CopilotAppCodeImpactChart's formatDate is stable east of UTC", () => {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      expect(formatCodeImpactDate("2026-07-29")).toBe("7/29");
    });
  });

  it("renders AutofixInsightChart with computed chart data", () => {
    render(<AutofixInsightChart available={100} committed={75} rate={75} />);

    expect(screen.getByText("75.0%")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("75")).toBeInTheDocument();

    const pie = screen.getByTestId("Pie");
    expect(pie.getAttribute("data-json")).toContain("Autofix Applied");
    expect(pie.getAttribute("data-json")).toContain("\"value\":25");
  });

  it("renders BillingChargeScopeChart with derived scope data", () => {
    render(<BillingChargeScopeChart userNet={500} orgNet={1500} />);

    const pie = screen
      .getAllByTestId("Pie")
      .find((node) => node.getAttribute("data-json")?.includes("\"User\""));

    expect(pie).toBeTruthy();
    expect(pie.getAttribute("data-json")).toContain("User");
    expect(pie?.getAttribute("data-json")).toContain("Org");
  });

  it("sorts and limits PremiumQuotaChart data before passing it to recharts", () => {
    const data = Array.from({ length: 16 }, (_, index) => ({
      username: `user-${index + 1}`,
      within_quota: 100 - index,
      over_quota: index,
      quota_limit: 120,
    }));

    render(<PremiumQuotaChart data={data} />);

    const barChart = screen.getByTestId("BarChart");
    const plotted = JSON.parse(barChart.getAttribute("data-json") ?? "[]") as Array<{
      username: string;
    }>;

    expect(plotted).toHaveLength(15);
    expect(plotted[0]?.username).toBe("user-1");
    expect(plotted.some((row) => row.username === "user-16")).toBe(false);
  });

  it("renders and sorts ModelFeatureTable rows", () => {
    render(
      <ModelFeatureTable
        data={[
          { model: "gpt-4", feature: "completion", featureLabel: "Completion", interactions: 100 },
          { model: "gpt-4", feature: "chat", featureLabel: "Chat", interactions: 50 },
          { model: "gpt-3.5", feature: "completion", featureLabel: "Completion", interactions: 25 },
        ]}
      />,
    );

    expect(screen.getByText("Model × Feature Breakdown")).toBeInTheDocument();
    const modelCells = () => screen.getAllByRole("cell").filter((cell) => cell.className.includes("font-medium"));
    const modelHeader = screen.getByRole("columnheader", { name: /Model/ });

    expect(modelCells()[0]).toHaveTextContent("gpt-4");
    fireEvent.click(modelHeader);
    fireEvent.click(modelHeader);
    expect(modelCells()[0]).toHaveTextContent("gpt-3.5");
  });

  it("renders Sparkline as a lightweight SVG helper", () => {
    const { container } = render(<Sparkline data={[10, 20, 15, 25]} color="#3b82f6" height={40} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
