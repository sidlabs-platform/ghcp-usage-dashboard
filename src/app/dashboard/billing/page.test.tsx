// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
    days: 28,
    startDate: "2026-08-01",
    endDate: "2026-08-28",
    period: null,
  } as DateState,
}));

const scopeState = vi.hoisted(() => ({
  hasFilter: false,
  buildScopeParams: vi.fn(() => new URLSearchParams()),
  selectedEntTeams: [] as string[],
  selectedOrgTeams: [] as string[],
  selectedOrgs: [] as string[],
}));

const exportMenuState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock("next/dynamic", () => ({
  default: () => function DynamicChart() {
    return <div data-testid="dynamic-chart" />;
  },
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => dateState.value,
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => scopeState,
}));

vi.mock("@/components/layout/PageHeader", () => ({
  PageHeader: ({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </header>
  ),
}));

vi.mock("@/components/cards/MetricCard", () => ({
  MetricCard: ({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {subtitle && <span>{subtitle}</span>}
    </section>
  ),
}));

vi.mock("@/components/states/ChartSkeleton", () => ({
  ChartSkeleton: () => <div>Loading chart…</div>,
}));

vi.mock("@/components/ui/ExportMenu", () => ({
  ExportMenu: (props: Record<string, unknown>) => {
    exportMenuState.props = props;
    return <button type="button">Export</button>;
  },
}));

vi.mock("@/components/billing/CopilotCostBasisPanel", () => ({
  CopilotCostBasisPanel: () => <div>Cost basis</div>,
}));

const billingResponse = {
  enabled: true,
  kpis: {
    totalNet: 100,
    totalGross: 120,
    totalDiscount: 20,
    userChargesNet: 70,
    orgChargesNet: 30,
  },
  dailyTrend: [],
  productBreakdown: [],
  orgBreakdown: [],
  userBreakdown: [],
  costCenterBreakdown: [],
  costBasis: null,
};

function paramsFor(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

describe("Billing overview page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
    exportMenuState.props = undefined;
    dateState.value = {
      mode: "preset",
      days: 28,
      startDate: "2026-08-01",
      endDate: "2026-08-28",
      period: null,
    };
  });

  it("sends explicit custom bounds to the billing API instead of a rolling days span", async () => {
    dateState.value = {
      mode: "custom",
      days: 31,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      period: null,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ json: async () => billingResponse }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    const Page = (await import("./page")).default;
    render(<Page />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/billing/overview?")));
    const params = paramsFor(String(fetchMock.mock.calls[0][0]));
    expect(params.get("startDate")).toBe("2026-03-01");
    expect(params.get("endDate")).toBe("2026-03-31");
    expect(params.has("days")).toBe(false);
    await screen.findByText("2026-03-01 to 2026-03-31");

    const pdfConfig = exportMenuState.props!.pdf as { filename: string; metadata: { dateRange: string } };
    expect(pdfConfig.filename).toBe("billing-overview-2026-03-01_2026-03-31");
    expect(pdfConfig.metadata.dateRange).toBe("2026-03-01 to 2026-03-31");
  });
});
