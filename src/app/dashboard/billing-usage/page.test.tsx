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

vi.mock("@/components/states/ChartSkeleton", () => ({
  ChartSkeleton: () => <div>Loading chart…</div>,
}));

vi.mock("@/components/ui/ExportMenu", () => ({
  ExportMenu: (props: Record<string, unknown>) => {
    exportMenuState.props = props;
    return <button type="button">Export</button>;
  },
}));

const usageResponse = {
  enabled: true,
  records: [
    {
      id: 1,
      date: "2026-03-01",
      product: "Copilot",
      sku: "sku",
      quantity: 1,
      unit_type: "ai-credits",
      applied_cost_per_quantity: 0.1,
      gross_amount: 0.1,
      discount_amount: 0,
      net_amount: 0.1,
      organization: "octo",
      repository: "repo",
      username: "alice",
      workflow_path: "",
      cost_center_name: "",
      charge_scope: "user",
    },
  ],
  pagination: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
  filterOptions: { products: [], skus: [], organizations: [], costCenters: [] },
};

function paramsFor(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

describe("Metered usage page", () => {
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

  it("sends explicit custom bounds to every metered usage request instead of a rolling days span", async () => {
    dateState.value = {
      mode: "custom",
      days: 31,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      period: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        json: async () => (url.includes("/summary?") ? { data: [] } : usageResponse),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const Page = (await import("./page")).default;
    render(<Page />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    for (const call of fetchMock.mock.calls) {
      const params = paramsFor(String(call[0]));
      expect(params.get("startDate")).toBe("2026-03-01");
      expect(params.get("endDate")).toBe("2026-03-31");
      expect(params.has("days")).toBe(false);
    }
    await screen.findByText(/Updated: 1 metered usage records, 2026-03-01 to 2026-03-31/);

    const csvConfig = exportMenuState.props!.csv as { filename: string; metadata: { dateRange: string } };
    expect(csvConfig.filename).toBe("metered-usage-2026-03-01_2026-03-31");
    expect(csvConfig.metadata.dateRange).toBe("2026-03-01 to 2026-03-31");
  });
});
