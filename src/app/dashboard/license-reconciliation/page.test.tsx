// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const dateRangeState = vi.hoisted(() => ({
  mode: "preset" as "preset" | "custom",
  days: 28,
  startDate: "2026-05-01",
  endDate: "2026-05-28",
}));

const scopeState = vi.hoisted(() => ({
  hasFilter: false,
  buildScopeParams: vi.fn(() => new URLSearchParams()),
  selectedEntTeams: [] as string[],
  selectedOrgTeams: [] as string[],
  selectedOrgs: [] as string[],
  selectedEnterprises: [] as string[],
  filterOptions: { enterprises: [{ slug: "acme", displayName: "Acme" }], enterpriseTeams: [], orgTeams: [], orgs: [] },
}));

const exportMenuState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

const tableState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

const filtersState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

const qualityState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

const runsState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => dateRangeState,
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
  MetricCard: ({ title, value }: { title: string; value: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      <span>{value}</span>
    </section>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

vi.mock("@/components/licensing/LicensePeriodFilters", () => ({
  LicensePeriodFilters: (props: Record<string, unknown>) => {
    filtersState.props = props;
    return <div>Filters</div>;
  },
}));

vi.mock("@/components/licensing/LicenseReconciliationTable", () => ({
  LicenseReconciliationTable: (props: Record<string, unknown>) => {
    tableState.props = props;
    return <div>Reconciliation table rows: {(props.rows as unknown[]).length}</div>;
  },
}));

vi.mock("@/components/licensing/LicenseDataQualityPanel", () => ({
  LicenseDataQualityPanel: (props: Record<string, unknown>) => {
    qualityState.props = props;
    return <div>Quality panel</div>;
  },
}));

vi.mock("@/components/licensing/LicenseRunHistory", () => ({
  LicenseRunHistory: (props: Record<string, unknown>) => {
    runsState.props = props;
    return <div>Run history</div>;
  },
}));

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => body,
  } as Response);
}

const enabledResponse = {
  enabled: true,
  coverage: { mode: "historical", periods: ["2026-05"], view: "detail" },
  dataSource: "historical",
  kpis: {
    totalUsers: 10,
    activeUsers: 9,
    pendingCancellation: 0,
    inactive30d: 1,
    zeroConsumptionSeats: 0,
    totalLicenseCost: 390,
    totalAllowanceCredits: 1000,
    totalAssignedUsd: 100,
    totalConsumedCredits: 500,
    totalConsumedUsd: 50,
    overallUtilizationPct: 50,
    overBudgetUsers: 0,
    totalCostOfOwnership: 440,
    currency: "USD",
  },
  rows: [{ resolvedUserLogin: "octocat" }],
  planBreakdown: [],
  orgBreakdown: [],
  utilizationBuckets: [],
  config: { currency: "USD", creditToUsd: 0.1 },
  pagination: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
  warnings: [],
};

describe("License reconciliation page", () => {
  beforeEach(() => {
    scopeState.hasFilter = false;
    scopeState.selectedEntTeams = [];
    scopeState.selectedOrgTeams = [];
    scopeState.selectedOrgs = [];
    scopeState.selectedEnterprises = [];
    exportMenuState.props = undefined;
    tableState.props = undefined;
    filtersState.props = undefined;
    qualityState.props = undefined;
    runsState.props = undefined;
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(enabledResponse)));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders three tabs with correct ARIA roles", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Overview", "Period Detail", "Data Quality"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-controls");
  });

  it("supports ArrowLeft/ArrowRight/Home/End keyboard navigation between tabs", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("clicking a tab switches the active panel", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Period Detail" }));
    expect(screen.getByRole("tab", { name: "Period Detail" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(tableState.props).toBeDefined());
  });

  it("builds fetch params from date range and scope", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((call: unknown[]) => String(call[0]).includes("/api/billing/license-reconciliation"))).toBe(true);
      expect(calls.some((call: unknown[]) => String(call[0]).includes("days=28"))).toBe(true);
    });
  });

  it("shows the historical coverage banner with selected periods and view", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText(/2026-05/);
    expect(screen.getByText(/Historical coverage:/i)).toBeInTheDocument();
  });

  it("shows an explicit amber live-snapshot-only banner and never presents it as full history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          ...enabledResponse,
          coverage: { mode: "live_snapshot_only", periods: ["2026-05"], view: "detail" },
          dataSource: "live_snapshot_only",
        }),
      ),
    );
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText(/live snapshot only/i);
    expect(screen.getByText(/historical periods unavailable/i)).toBeInTheDocument();
  });

  it("shows a missing-history empty state that teaches next steps, not a successful zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          ...enabledResponse,
          kpis: { ...enabledResponse.kpis, totalUsers: 0 },
          rows: [],
          pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
        }),
      ),
    );
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText(/run sync|change periods|clear filters/i);
  });

  it("preserves existing KPI/chart rendering on the Overview tab", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText("Licensed Users");
    expect(screen.getByText("Monthly License Cost")).toBeInTheDocument();
    expect(screen.getByText("AI Credits (attributed)")).toBeInTheDocument();
    expect(screen.getByText("Credit Utilization")).toBeInTheDocument();
    expect(screen.getByText(/utilization distribution is unavailable/i)).toBeInTheDocument();
  });

  it("passes current periods/scope/view params to CSV export via the existing hook", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await waitFor(() => expect(exportMenuState.props).toBeDefined());
    const csvConfig = exportMenuState.props!.csv as { fetchUrl: string; extraParams: URLSearchParams };
    expect(csvConfig.fetchUrl).toBe("/api/billing/license-reconciliation");
    expect(csvConfig.extraParams.get("days")).toBe("28");
  });

  it("shows an error state with a retry button", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ error: "boom" }, false));
    vi.stubGlobal("fetch", fetchMock);
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText(/failed/i);
    const retry = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("fetches capability preflight for the active enterprise in Data Quality", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/preflight")) {
        return jsonResponse({
          enterpriseSlug: "acme",
          ok: true,
          capabilities: [
            {
              capability: "copilot_seats",
              label: "Copilot seat assignments",
              status: "supported",
              required: true,
              message: "Access confirmed.",
            },
          ],
        });
      }
      return jsonResponse(enabledResponse);
    });
    vi.stubGlobal("fetch", fetchMock);
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText("Licensed Users");

    fireEvent.click(screen.getByRole("tab", { name: "Data Quality" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/preflight?enterprise=acme"),
        expect.objectContaining({ cache: "no-store" }),
      );
      expect(qualityState.props?.preflight).toEqual(expect.objectContaining({ enterpriseSlug: "acme" }));
    });
  });

  it("ignores a stale response that resolves after a newer search", async () => {
    let resolveOld: (value: Response) => void = () => {};
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search=old")) return oldResponse;
      if (url.includes("search=new")) {
        return jsonResponse({
          ...enabledResponse,
          kpis: { ...enabledResponse.kpis, totalUsers: 20 },
        });
      }
      return jsonResponse(enabledResponse);
    });
    vi.stubGlobal("fetch", fetchMock);
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText("Licensed Users");

    act(() => {
      (filtersState.props?.onSearchChange as (value: string) => void)("old");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("search=old")));
    act(() => {
      (filtersState.props?.onSearchChange as (value: string) => void)("new");
    });
    await screen.findByText("20");

    resolveOld({
      ok: true,
      json: async () => ({
        ...enabledResponse,
        kpis: { ...enabledResponse.kpis, totalUsers: 99 },
      }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.queryByText("99")).not.toBeInTheDocument();
  });

  it("keeps existing controls available when a refresh request fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search=fail")) return jsonResponse({ error: "boom" }, false);
      return jsonResponse(enabledResponse);
    });
    vi.stubGlobal("fetch", fetchMock);
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText("Licensed Users");

    act(() => {
      (filtersState.props?.onSearchChange as (value: string) => void)("fail");
    });

    await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByText(/Reconciliation table rows/i)).toBeInTheDocument();
  });

  it("resets sort to the cross-mode total-cost default when the view changes", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);
    await screen.findByText("Licensed Users");

    act(() => {
      (tableState.props?.onSort as (field: string) => void)("billing_period");
    });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("sort=billing_period")),
    );

    act(() => {
      (filtersState.props?.onViewChange as (view: "detail" | "rollup") => void)("rollup");
    });

    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        calls.some((call: unknown[]) => {
          const url = String(call[0]);
          return url.includes("view=rollup") && url.includes("sort=total_cost");
        }),
      ).toBe(true);
    });
  });
});
