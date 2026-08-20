// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mockScope = vi.hoisted(() => ({
  hasFilter: false,
  clearAll: vi.fn(),
  // Must be a stable identity, exactly like the real context's useCallback.
  // A fresh arrow per render would change `fetchData`'s identity every render
  // and put the page's `useEffect(..., [fetchData])` into an endless refetch
  // loop, which never settles for the assertions below.
  buildScopeParams: () => new URLSearchParams(),
}));

const mockDateRange = vi.hoisted(() => ({
  mode: "month" as "preset" | "custom" | "month",
  days: 31,
  startDate: "2026-07-01",
  endDate: "2026-07-31",
}));

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="dynamic-chart" />,
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => mockDateRange,
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => ({
    hasFilter: mockScope.hasFilter,
    buildScopeParams: mockScope.buildScopeParams,
    clearAll: mockScope.clearAll,
  }),
}));

vi.mock("@/components/layout/PageHeader", () => ({
  PageHeader: ({ title, description }: { title: string; description: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}));

vi.mock("@/components/filters/ScopeFilter", () => ({
  ScopeFilter: () => <div>Scope Filter</div>,
}));

describe("DashboardOverview", { timeout: 20000 }, () => {
  afterEach(() => {
    cleanup();
    mockScope.hasFilter = false;
    mockScope.clearAll.mockReset();
    mockScope.buildScopeParams = () => new URLSearchParams();
    mockDateRange.mode = "month";
    mockDateRange.days = 31;
    mockDateRange.startDate = "2026-07-01";
    mockDateRange.endDate = "2026-07-31";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not request security overview when a team filter is active", async () => {
    mockScope.buildScopeParams = () => new URLSearchParams("teams=ent1:platform");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return Promise.resolve({
          json: async () => ({ metrics: { codeScanning: { enabled: true } } }),
        } as Response);
      }
      if (String(input).startsWith("/api/metrics/overview?")) {
        return Promise.resolve({
          json: async () => ({ error: "No fixture data required." }),
        } as Response);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const Page = (await import("./page")).default;
    render(<Page />);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/metrics/overview?startDate=2026-07-01&endDate=2026-07-31&teams=ent1%3Aplatform",
      );
    });
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).startsWith("/api/security/overview?"),
    )).toBe(false);
  });

  it("refetches an explicit calendar range when changing between equal-length months", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return Promise.resolve({
          json: async () => ({ metrics: {} }),
        } as Response);
      }
      if (String(input).startsWith("/api/metrics/overview?")) {
        return Promise.resolve({
          json: async () => ({ error: "No fixture data required." }),
        } as Response);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const Page = (await import("./page")).default;
    const { rerender } = render(<Page />);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/metrics/overview?startDate=2026-07-01&endDate=2026-07-31",
      );
    });

    mockDateRange.startDate = "2026-08-01";
    mockDateRange.endDate = "2026-08-31";
    rerender(<Page />);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/metrics/overview?startDate=2026-08-01&endDate=2026-08-31",
      );
    });
  });

  it("renders the error state with the server error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === "/api/config") {
          return Promise.resolve({
            json: async () => ({ metrics: {} }),
          } as Response);
        }
        if (String(input).startsWith("/api/metrics/overview?")) {
          return Promise.resolve({
            json: async () => ({ error: "Sync metrics before opening the overview." }),
          } as Response);
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );

    const Page = (await import("./page")).default;
    render(<Page />);

    expect(
      await screen.findByRole("heading", { name: "Error loading data" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Sync metrics before opening the overview.")).toBeInTheDocument();
    expect(
      screen.getByText("If metrics have not been synced yet, click the Sync button in the header."),
    ).toBeInTheDocument();
  });

  it("renders an actionable empty state when loading finishes with no data", async () => {
    mockScope.hasFilter = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === "/api/config") {
          return Promise.resolve({
            json: async () => ({ metrics: {} }),
          } as Response);
        }
        if (String(input).startsWith("/api/metrics/overview?")) {
          return Promise.resolve({
            json: async () => "",
          } as Response);
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );

    const Page = (await import("./page")).default;
    render(<Page />);

    expect(
      await screen.findByRole("heading", { name: "No data available" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("Scope Filter")).toBeInTheDocument();
    expect(screen.getByText("No data matches the current filters.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(mockScope.clearAll).toHaveBeenCalledTimes(1);
  });
});
