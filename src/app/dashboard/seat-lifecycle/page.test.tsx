// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const chartState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

const scopeState = vi.hoisted(() => ({
  query: "",
}));

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
    days: 30,
    startDate: "2025-05-10",
    endDate: "2025-06-08",
    period: null,
  } as DateState,
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => dateState.value,
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => ({
    hasFilter: scopeState.query !== "",
    buildScopeParams: () => new URLSearchParams(scopeState.query),
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
    format,
    subtitle,
  }: {
    title: string;
    value: number | string;
    format?: "number" | "percent" | "raw";
    subtitle?: string;
  }) => {
    const displayValue = typeof value === "number" && format === "percent" ? `${value.toFixed(1)}%` : value;
    return (
      <div>
        <span>{title}</span>
        <span data-testid={`metric-${title}`}>{displayValue}</span>
        {subtitle && <span>{subtitle}</span>}
      </div>
    );
  },
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
    display_login: overrides.display_login ?? overrides.user_login ?? "alice",
    login_resolved: false,
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

function paramsForCall(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

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
  return import("./page").then(({ default: Page }) => {
    const ui = (
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>
    );
    return { ...render(ui), Page, queryClient };
  });
}

describe("Seat onboarding & offboarding page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
    chartState.props = undefined;
    scopeState.query = "";
    dateState.value = {
      mode: "preset",
      days: 30,
      startDate: "2025-05-10",
      endDate: "2025-06-08",
      period: null,
    };
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
    expect(screen.getByTestId("metric-Churn Rate")).toHaveTextContent("3.4%");

    expect(screen.getByTestId("trend-chart")).toHaveTextContent("Trend rows: 2");
    expect(screen.getByRole("link", { name: "alice" })).toHaveAttribute("href", "/dashboard/users/alice");
    expect(screen.getByRole("link", { name: "bob" })).toBeInTheDocument();
    expect(screen.getByText("Seat sync")).toBeInTheDocument();
  });

  it("links to the resolved login while keeping the stored hash discoverable", async () => {
    const rawLogin = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    await renderPage(
      emptyPayload({
        offboarded: {
          rows: [makeRow({
            user_login: rawLogin,
            display_login: "real-dev",
            login_resolved: true,
            event_type: "offboarded",
            source: "sync_diff",
          })],
          pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "real-dev" })).toHaveAttribute("href", "/dashboard/users/real-dev"),
    );
    expect(screen.getByText(`Stored: ${rawLogin}`)).toBeInTheDocument();
  });

  it("renders an empty churn-rate value when there are no seats to compare", async () => {
    await renderPage(emptyPayload({ stats: { ...emptyPayload().stats, churnRate: null } }));

    await waitFor(() =>
      expect(
        screen.getByText(
          (_, el) =>
            el?.tagName === "P" &&
            /Last 30 days/.test(el.textContent ?? "") &&
            /2025-05-10 → 2025-06-08/.test(el.textContent ?? ""),
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("metric-Churn Rate")).toHaveTextContent("—");
    expect(screen.getByTestId("metric-Churn Rate")).not.toHaveTextContent("0.0%");
    expect(screen.getByText("No seats to compare")).toBeInTheDocument();
  });

  it("renders a real zero churn rate distinctly from a missing churn rate", async () => {
    await renderPage(
      emptyPayload({
        stats: {
          onboardedUsers: 2,
          offboardedUsers: 0,
          onboardedEvents: 2,
          offboardedEvents: 0,
          netChange: 2,
          churnRate: 0,
        },
        coverage: { source: "sync_diff", trackingStartedAt: "2025-05-01T00:00:00Z", onboardingOnly: false },
      }),
    );

    await waitFor(() => expect(screen.getByText("Offboarded / total seats")).toBeInTheDocument());
    expect(screen.getByTestId("metric-Churn Rate")).toHaveTextContent("0.0%");
    expect(screen.getByTestId("metric-Churn Rate")).not.toHaveTextContent("—");
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
      expect(screen.getByText(/sourced from the GitHub audit log/i)).toBeInTheDocument(),
    );
  });

  it("states the window the audit log actually covers", async () => {
    await renderPage(
      emptyPayload({
        coverage: {
          source: "audit_log",
          trackingStartedAt: null,
          onboardingOnly: false,
          sourceBreakdown: { audit_log: 4, sync_diff: 0, seat_created_at: 2 },
          audit: {
            status: "ok",
            reason: null,
            coveredFrom: "2025-03-01T00:00:00.000Z",
            coveredThrough: "2025-06-08T00:00:00.000Z",
            lastSyncedAt: "2025-06-08T06:00:00.000Z",
            truncated: false,
          },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/sourced from the GitHub audit log/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("2025-03-01")).toBeInTheDocument();
    expect(screen.getByText("2025-06-08")).toBeInTheDocument();
  });

  it("renders an audit warning carried on an otherwise successful audit sync", async () => {
    await renderPage(
      emptyPayload({
        coverage: {
          source: "audit_log",
          trackingStartedAt: null,
          onboardingOnly: false,
          sourceBreakdown: { audit_log: 4, sync_diff: 0, seat_created_at: 2 },
          audit: {
            status: "ok",
            reason: "Audit log unavailable for 1 organization(s).",
            coveredFrom: "2025-03-01T00:00:00.000Z",
            coveredThrough: "2025-06-08T00:00:00.000Z",
            lastSyncedAt: "2025-06-08T06:00:00.000Z",
            truncated: false,
          },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/sourced from the GitHub audit log/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Audit log unavailable for 1 organization\(s\)\./)).toBeInTheDocument();
  });

  it("distinguishes snapshot-derived offboarding outside the audit window", async () => {
    await renderPage(
      emptyPayload({
        coverage: {
          source: "audit_log",
          trackingStartedAt: "2025-01-15T00:00:00Z",
          onboardingOnly: false,
          sourceBreakdown: { audit_log: 4, sync_diff: 3, seat_created_at: 2 },
          audit: {
            status: "ok",
            reason: null,
            coveredFrom: "2025-03-01T00:00:00.000Z",
            coveredThrough: "2025-06-08T00:00:00.000Z",
            lastSyncedAt: "2025-06-08T06:00:00.000Z",
            truncated: false,
          },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/Outside that window, offboarding/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/derived from seat-sync snapshots/i)).toBeInTheDocument();
    expect(screen.getByText("2025-01-15")).toBeInTheDocument();
  });

  it("says so, with the reason, when the audit log is unavailable", async () => {
    await renderPage(
      emptyPayload({
        coverage: {
          source: "sync_diff",
          trackingStartedAt: "2025-05-01T00:00:00Z",
          onboardingOnly: false,
          sourceBreakdown: { audit_log: 0, sync_diff: 3, seat_created_at: 2 },
          audit: {
            status: "unavailable",
            reason: "The configured token is missing the read:audit_log scope.",
            coveredFrom: null,
            coveredThrough: null,
            lastSyncedAt: "2025-06-08T06:00:00.000Z",
            truncated: false,
          },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/The audit log is not available/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/read:audit_log scope/i)).toBeInTheDocument();
    // The snapshot fallback must still be named as the source in use.
    expect(screen.getByText(/derived from seat-sync snapshots/i)).toBeInTheDocument();
  });

  it("warns when the last audit sync failed", async () => {
    await renderPage(
      emptyPayload({
        coverage: {
          source: "sync_diff",
          trackingStartedAt: "2025-05-01T00:00:00Z",
          onboardingOnly: false,
          sourceBreakdown: { audit_log: 0, sync_diff: 3, seat_created_at: 0 },
          audit: {
            status: "error",
            reason: "GitHub API error 502 fetching Copilot audit log events.",
            coveredFrom: null,
            coveredThrough: null,
            lastSyncedAt: "2025-06-08T06:00:00.000Z",
            truncated: false,
          },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/last audit log sync did not complete/i)).toBeInTheDocument(),
    );
  });

  it("flags a truncated audit fetch as still filling in", async () => {
    await renderPage(
      emptyPayload({
        coverage: {
          source: "audit_log",
          trackingStartedAt: null,
          onboardingOnly: false,
          sourceBreakdown: { audit_log: 9, sync_diff: 0, seat_created_at: 0 },
          audit: {
            status: "ok",
            reason:
              "Copilot audit log pagination truncated after reaching the 100-page limit while more results were still available.",
            coveredFrom: "2025-05-01T00:00:00.000Z",
            coveredThrough: "2025-06-08T00:00:00.000Z",
            lastSyncedAt: "2025-06-08T06:00:00.000Z",
            truncated: true,
          },
        },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/more pages than a single sync reads/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/pagination truncated after reaching/i)).not.toBeInTheDocument();
  });

  it("requests the preset window selected in the shared date range", async () => {
    const { rerender, Page, queryClient } = await renderPage(emptyPayload());

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain("days=30");
    // A preset must never be sent as bounds — it means "the last N days ending
    // yesterday", recomputed per request, not a frozen window.
    expect(calls[0]).not.toContain("startDate=");

    calls.length = 0;
    dateState.value = { ...dateState.value, days: 90, startDate: "2025-03-11", endDate: "2025-06-08" };
    rerender(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(calls.some((c) => c.includes("days=90"))).toBe(true));
  });

  it("resets table pages when the scope filter changes", async () => {
    const { rerender, Page, queryClient } = await renderPage(
      emptyPayload({
        onboarded: {
          rows: [makeRow()],
          pagination: { page: 1, pageSize: 25, totalItems: 75, totalPages: 3 },
        },
        offboarded: {
          rows: [makeRow({ user_login: "bob", event_type: "offboarded", source: "sync_diff" })],
          pagination: { page: 1, pageSize: 25, totalItems: 75, totalPages: 3 },
        },
      }),
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const nextButtons = await screen.findAllByRole("button", { name: "Next" });
    fireEvent.click(nextButtons[0]);
    await waitFor(() =>
      expect(
        calls.some((call) => {
          const params = paramsForCall(call);
          return params.get("onboardedPage") === "2" && params.get("offboardedPage") === "1";
        }),
      ).toBe(true),
    );

    const updatedNextButtons = await screen.findAllByRole("button", { name: "Next" });
    fireEvent.click(updatedNextButtons[1]);

    await waitFor(() =>
      expect(
        calls.some((call) => {
          const params = paramsForCall(call);
          return params.get("onboardedPage") === "2" && params.get("offboardedPage") === "2";
        }),
      ).toBe(true),
    );
    calls.length = 0;

    scopeState.query = "teams=team-b";
    rerender(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        calls.some((call) => {
          const params = paramsForCall(call);
          return (
            params.get("teams") === "team-b" &&
            params.get("onboardedPage") === "1" &&
            params.get("offboardedPage") === "1"
          );
        }),
      ).toBe(true),
    );
    expect(
      calls.some((call) => {
        const params = paramsForCall(call);
        return (
          params.get("teams") === "team-b" &&
          (params.get("onboardedPage") !== "1" || params.get("offboardedPage") !== "1")
        );
      }),
    ).toBe(false);
  });

  it("sends explicit bounds when the shared selector is in month mode", async () => {
    dateState.value = {
      mode: "month",
      days: 31,
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      period: "2025-01",
    };
    await renderPage(emptyPayload());

    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("startDate=2025-01-01") && c.includes("endDate=2025-01-31")),
      ).toBe(true),
    );
    // Sending `days` alongside a month would let the route silently resolve the
    // rolling window instead of the month the reader picked.
    expect(calls.some((c) => c.includes("days="))).toBe(false);
  });

  it("sends explicit bounds for a custom range", async () => {
    dateState.value = {
      mode: "custom",
      days: 15,
      startDate: "2025-02-01",
      endDate: "2025-02-15",
      period: null,
    };
    await renderPage(emptyPayload());

    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("startDate=2025-02-01") && c.includes("endDate=2025-02-15")),
      ).toBe(true),
    );
  });

  it("resets table pages when the shared window changes", async () => {
    const { rerender, Page, queryClient } = await renderPage(
      emptyPayload({
        onboarded: {
          rows: [makeRow()],
          pagination: { page: 1, pageSize: 25, totalItems: 75, totalPages: 3 },
        },
        offboarded: {
          rows: [makeRow({ user_login: "bob", event_type: "offboarded", source: "sync_diff" })],
          pagination: { page: 1, pageSize: 25, totalItems: 75, totalPages: 3 },
        },
      }),
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const nextButtons = await screen.findAllByRole("button", { name: "Next" });
    fireEvent.click(nextButtons[0]);
    await waitFor(() =>
      expect(calls.some((c) => paramsForCall(c).get("onboardedPage") === "2")).toBe(true),
    );
    calls.length = 0;

    dateState.value = {
      mode: "month",
      days: 31,
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      period: "2025-01",
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        calls.some((call) => {
          const params = paramsForCall(call);
          return (
            params.get("startDate") === "2025-01-01" &&
            params.get("onboardedPage") === "1" &&
            params.get("offboardedPage") === "1"
          );
        }),
      ).toBe(true),
    );
    expect(
      calls.some((call) => {
        const params = paramsForCall(call);
        return params.get("startDate") === "2025-01-01" && params.get("onboardedPage") !== "1";
      }),
    ).toBe(false);
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
