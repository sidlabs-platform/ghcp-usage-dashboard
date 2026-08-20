// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const chartState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => ({
    hasFilter: false,
    buildScopeParams: () => new URLSearchParams(),
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

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
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
      <span data-testid={`metric-${title}`}>{value}</span>
      {subtitle && <span>{subtitle}</span>}
    </div>
  ),
}));

vi.mock("@/components/charts/SeatLifecycleTrendChart", () => ({
  SeatLifecycleTrendChart: (props: Record<string, unknown>) => {
    chartState.props = props;
    return <div data-testid="trend-chart">Trend rows: {(props.data as unknown[]).length}</div>;
  },
}));

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    enterprise_slug: "ent-a",
    org_slug: "org-a",
    user_login: "alice",
    user_id: 1,
    event_type: "onboarded",
    event_date: "2025-06-05",
    occurred_at: "2025-06-05T09:00:00Z",
    plan_type: "business",
    assigning_team_slug: "team-a",
    assigning_team_name: "Team A",
    last_activity_at: "2025-06-06T10:00:00Z",
    source: "seat_created_at",
    ...overrides,
  };
}

function emptyPayload(overrides: Record<string, unknown> = {}) {
  return {
    window: { start: "2025-05-10", end: "2025-06-08", explicit: false },
    stats: {
      onboardedUsers: 0,
      offboardedUsers: 0,
      onboardedEvents: 0,
      offboardedEvents: 0,
      netChange: 0,
      churnRate: null,
    },
    trend: [],
    onboarded: { rows: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 1 } },
    offboarded: { rows: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 1 } },
    coverage: { source: "none", trackingStartedAt: null, onboardingOnly: false },
    filtered: false,
    available: true,
    ...overrides,
  };
}

const calls: string[] = [];

function renderPage(payload: unknown, status = 200) {
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(String(url));
    return {
      ok: status === 200,
      status,
      json: async () => payload,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchImpl);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return import("./page").then(({ default: Page }) =>
    render(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    ),
  );
}

describe("Seat onboarding & offboarding page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
    chartState.props = undefined;
    calls.length = 0;
  });

  it("renders KPIs, trend chart and both tables from the API payload", async () => {
    await renderPage(
      emptyPayload({
        stats: {
          onboardedUsers: 12,
          offboardedUsers: 5,
          onboardedEvents: 13,
          offboardedEvents: 5,
          netChange: 7,
          churnRate: 3.4,
        },
        trend: [
          { day: "2025-06-01", onboarded: 2, offboarded: 1, net: 1 },
          { day: "2025-06-02", onboarded: 3, offboarded: 0, net: 3 },
        ],
        onboarded: {
          rows: [makeRow()],
          pagination: { page: 1, pageSize: 25, totalItems: 12, totalPages: 1 },
        },
        offboarded: {
          rows: [makeRow({ user_login: "bob", event_type: "offboarded", source: "sync_diff" })],
          pagination: { page: 1, pageSize: 25, totalItems: 5, totalPages: 1 },
        },
        coverage: { source: "sync_diff", trackingStartedAt: "2025-05-01T00:00:00Z", onboardingOnly: false },
      }),
    );

    expect(screen.getByRole("heading", { name: "Onboarding & Offboarding" })).toBeInTheDocument();
    expect(screen.getByText("Scope Filter")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("metric-Onboarded")).toHaveTextContent("12"));
    expect(screen.getByTestId("metric-Offboarded")).toHaveTextContent("5");
    expect(screen.getByTestId("metric-Net Change")).toHaveTextContent("7");
    expect(screen.getByTestId("metric-Churn Rate")).toHaveTextContent("3.4");

    expect(screen.getByTestId("trend-chart")).toHaveTextContent("Trend rows: 2");
    expect(screen.getByRole("link", { name: "alice" })).toHaveAttribute("href", "/dashboard/users/alice");
    expect(screen.getByRole("link", { name: "bob" })).toBeInTheDocument();
    expect(screen.getByText("Seat sync")).toBeInTheDocument();
  });

  it("shows the tracking-start coverage banner for snapshot-diff installs", async () => {
    await renderPage(
      emptyPayload({
        coverage: { source: "sync_diff", trackingStartedAt: "2025-05-01T00:00:00Z", onboardingOnly: false },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/has been tracked since/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("2025-05-01")).toBeInTheDocument();
  });

  it("shows an explicit empty state when offboard tracking has not started", async () => {
    await renderPage(emptyPayload());

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Offboarding tracking has not started yet/i })).toBeInTheDocument(),
    );
    expect(screen.getByText("Offboarding tracking has not started yet.")).toBeInTheDocument();
  });

  it("labels audit-log-sourced data", async () => {
    await renderPage(
      emptyPayload({ coverage: { source: "audit_log", trackingStartedAt: null, onboardingOnly: false } }),
    );

    await waitFor(() =>
      expect(screen.getByText(/sourced from the enterprise audit log/i)).toBeInTheDocument(),
    );
  });

  it("requests the selected preset window", async () => {
    await renderPage(emptyPayload());

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain("days=30");

    fireEvent.click(screen.getByRole("button", { name: "90d" }));

    await waitFor(() => expect(calls.some((c) => c.includes("days=90"))).toBe(true));
  });

  it("switches to an explicit start/end override once both dates are set", async () => {
    await renderPage(emptyPayload());
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2025-01-31" } });

    await waitFor(() =>
      expect(calls.some((c) => c.includes("start=2025-01-01") && c.includes("end=2025-01-31"))).toBe(true),
    );
    // A half-filled pair must never be sent — it would 400 on every keystroke.
    expect(calls.some((c) => c.includes("start=2025-01-01") && !c.includes("end="))).toBe(false);
  });

  it("blocks an inverted custom range client-side instead of requesting it", async () => {
    await renderPage(emptyPayload());
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const before = calls.length;

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-03-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2025-01-01" } });

    await waitFor(() => expect(screen.getByText(/must be on or before/i)).toBeInTheDocument());
    expect(calls.length).toBe(before);
  });

  it("builds an export link covering the whole window, not just the current page", async () => {
    await renderPage(emptyPayload());

    const link = screen.getByRole("link", { name: /Export CSV/i });
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("/api/export/seat-lifecycle?");
    expect(href).toContain("days=30");
    expect(href).not.toContain("pageSize");
    expect(href).not.toContain("onboardedPage");
  });

  it("surfaces an API error without crashing", async () => {
    await renderPage({ error: "Date range spans 400 days" }, 400);

    await waitFor(() => expect(screen.getByText("Date range spans 400 days")).toBeInTheDocument());
  });
});
