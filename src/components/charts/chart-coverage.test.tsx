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
  Area: () => null,
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
