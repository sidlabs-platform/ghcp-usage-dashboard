// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { CopilotAppAnalyticsResponse } from "@/lib/types/metrics";

const scopeState = vi.hoisted(() => ({
  params: new URLSearchParams(),
}));

const tableState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => ({ mode: "preset", days: 30, startDate: "", endDate: "" }),
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => ({
    hasFilter: scopeState.params.toString().length > 0,
    buildScopeParams: () => new URLSearchParams(scopeState.params),
  }),
}));

vi.mock("@/components/layout/PageHeader", () => ({
  PageHeader: ({
    title,
    description,
    children,
  }: {
    title: string;
    description?: string;
    children?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {children}
    </header>
  ),
}));

vi.mock("@/components/filters/ScopeFilter", () => ({
  ScopeFilter: () => <div>Scope Filter</div>,
}));

vi.mock("@/components/states/ChartSkeleton", () => ({
  ChartSkeleton: () => <div>Chart Loading</div>,
  KPISkeleton: () => <div>KPI Loading</div>,
}));

vi.mock("@/components/ui/Section", () => ({
  Section: ({
    title,
    description,
    children,
  }: {
    title: string;
    description?: string;
    children?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </section>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/cards/MetricCard", () => ({
  MetricCard: ({
    title,
    value,
    subtitle,
  }: {
    title: string;
    value: React.ReactNode;
    subtitle?: string;
  }) => (
    <div>
      <span>{title}</span>
      <span>{value}</span>
      {subtitle && <span>{subtitle}</span>}
    </div>
  ),
}));

vi.mock("@/components/ui/ExportMenu", () => ({
  ExportMenu: () => <button type="button">Export</button>,
}));

vi.mock("@/components/tables/PaginatedTable", () => ({
  PaginatedTable: (props: Record<string, unknown>) => {
    tableState.props = props;
    return <div>Copilot App adopters table</div>;
  },
}));

vi.mock("@/components/charts/CopilotAppAdoptionVolumeChart", () => ({
  CopilotAppAdoptionVolumeChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="adoption-volume-chart">Adoption chart rows: {data.length}</div>
  ),
}));

vi.mock("@/components/charts/CopilotAppCodeImpactChart", () => ({
  CopilotAppCodeImpactChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="code-impact-chart">Code impact chart rows: {data.length}</div>
  ),
}));

function fullResponse(): CopilotAppAnalyticsResponse {
  return {
    hasCopilotAppData: true,
    dataSource: "users",
    capabilities: { adopters: true, scopedFiltering: true, modelBreakdown: true, languageBreakdown: true },
    kpis: {
      periodActiveUsers: 500,
      appActiveUsers: 120,
      adoptionRate: 24,
      sessions: 900,
      requests: 4500,
      prompts: 3000,
      promptTokens: 200000,
      outputTokens: 150000,
      avgTokensPerRequest: 78,
      codeGenerations: 800,
      codeAcceptances: 600,
      locAdded: 12000,
      locDeleted: 3000,
      locChanged: 15000,
    },
    adoptionTrend: [
      { day: "2026-08-01", activeUsers: 100, sessions: 300, requests: 1500, prompts: 1000 },
      { day: "2026-08-02", activeUsers: 110, sessions: 320, requests: 1600, prompts: 1050 },
    ],
    codeImpactTrend: [
      { day: "2026-08-01", generations: 400, acceptances: 300, locAdded: 6000, locDeleted: 1500 },
      { day: "2026-08-02", generations: 420, acceptances: 310, locAdded: 6200, locDeleted: 1550 },
    ],
    modelBreakdown: [{ name: "gpt-5", interactions: 500, locAdded: 8000, locDeleted: 2000 }],
    languageBreakdown: [{ name: "TypeScript", interactions: 600, locAdded: 9000, locDeleted: 2200 }],
  };
}

function aggregateResponse(): CopilotAppAnalyticsResponse {
  return {
    hasCopilotAppData: true,
    dataSource: "enterprise",
    capabilities: { adopters: false, scopedFiltering: false, modelBreakdown: false, languageBreakdown: false },
    kpis: {
      periodActiveUsers: 0,
      appActiveUsers: 80,
      adoptionRate: 0,
      sessions: 500,
      requests: 2500,
      prompts: 1800,
      promptTokens: 90000,
      outputTokens: 60000,
      avgTokensPerRequest: 60,
      codeGenerations: 300,
      codeAcceptances: 220,
      locAdded: 5000,
      locDeleted: 1200,
      locChanged: 6200,
    },
    adoptionTrend: [{ day: "2026-08-01", activeUsers: 80, sessions: 500, requests: 2500, prompts: 1800 }],
    codeImpactTrend: [{ day: "2026-08-01", generations: 300, acceptances: 220, locAdded: 5000, locDeleted: 1200 }],
    modelBreakdown: [],
    languageBreakdown: [],
  };
}

function noDataResponse(): CopilotAppAnalyticsResponse {
  return {
    hasCopilotAppData: false,
    dataSource: "none",
    capabilities: { adopters: false, scopedFiltering: false, modelBreakdown: false, languageBreakdown: false },
    kpis: {
      periodActiveUsers: 0,
      appActiveUsers: 0,
      adoptionRate: 0,
      sessions: 0,
      requests: 0,
      prompts: 0,
      promptTokens: 0,
      outputTokens: 0,
      avgTokensPerRequest: 0,
      codeGenerations: 0,
      codeAcceptances: 0,
      locAdded: 0,
      locDeleted: 0,
      locChanged: 0,
    },
    adoptionTrend: [],
    codeImpactTrend: [],
    modelBreakdown: [],
    languageBreakdown: [],
  };
}

function renderPage(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return import("./page").then(({ default: Page }) =>
    render(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    ),
  );
}

describe("Copilot App analytics page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
    tableState.props = undefined;
    scopeState.params = new URLSearchParams();
  });

  it("renders the full analytics view with KPIs, charts, composition, and adopters", async () => {
    const fetchMock = vi.fn(async (_input: string) =>
      new Response(JSON.stringify(fullResponse()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await renderPage(fetchMock as unknown as typeof fetch);

    expect(await screen.findByRole("heading", { name: "Copilot App Analytics" })).toBeInTheDocument();
    expect(await screen.findByText("App Active Users")).toBeInTheDocument();
    expect(screen.getByText("App Adoption")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Requests")).toBeInTheDocument();
    expect(screen.getByText("Prompts")).toBeInTheDocument();
    expect(screen.getByText("App LoC Changed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Top Copilot App Adopters" })).toBeInTheDocument();
    });
    expect(screen.getByText("Copilot App adopters table")).toBeInTheDocument();
    expect(tableState.props).toMatchObject({
      fetchUrl: "/api/metrics/copilot-app/adopters",
      defaultSort: "sessions",
      defaultSortDir: "desc",
      queryKey: "copilot-app-adopters",
      searchable: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("adoption-volume-chart")).toHaveTextContent("Adoption chart rows: 2");
      expect(screen.getByTestId("code-impact-chart")).toHaveTextContent("Code impact chart rows: 2");
    });

    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();

    const firstCallUrl = fetchMock.mock.calls[0][0] as string;
    expect(firstCallUrl).toContain("/api/metrics/copilot-app?");
    expect(firstCallUrl).toContain("days=30");
  });

  it("shows the exact no-data message when Copilot App data is absent from the synced range", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(noDataResponse()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await renderPage(fetchMock as unknown as typeof fetch);

    expect(
      await screen.findByText(/No Copilot App metrics are present in the selected synced range/),
    ).toBeInTheDocument();
  });

  it("falls back to aggregate KPIs/trends and hides adopters when user attribution is unavailable", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(aggregateResponse()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await renderPage(fetchMock as unknown as typeof fetch);

    expect(await screen.findByText(/User-attributed App data is unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Top Copilot App Adopters" })).not.toBeInTheDocument();
    // KPIs and trends still render from the aggregate fallback.
    expect(screen.getByText("App Active Users")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("adoption-volume-chart")).toHaveTextContent("Adoption chart rows: 1");
    });
  });

  it("shows an error state with retry copy when the request fails", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));

    await renderPage(fetchMock as unknown as typeof fetch);

    expect(await screen.findByText("Error loading data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("includes days and scope params in the request URL", async () => {
    scopeState.params = new URLSearchParams({ teams: "team-a", orgs: "org-b" });
    const fetchMock = vi.fn(async (_input: string) =>
      new Response(JSON.stringify(fullResponse()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await renderPage(fetchMock as unknown as typeof fetch);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("days=30");
    expect(url).toContain("teams=team-a");
    expect(url).toContain("orgs=org-b");
  });
});
