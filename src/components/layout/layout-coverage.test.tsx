// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { DashboardShell } from "@/components/layout/DashboardShell";

const mockState = vi.hoisted(() => ({
  pathname: "/dashboard",
  invalidateQueries: vi.fn(),
  useKeyboardShortcuts: vi.fn(),
  dateRangeState: {
    mode: "preset" as "preset" | "custom" | "month",
    days: 7,
    startDate: "2024-01-01",
    endDate: "2024-01-07",
    period: null as string | null,
    setDays: vi.fn(),
    setCustomRange: vi.fn(),
    setMonth: vi.fn(),
  },
  sidebarState: {
    isOpen: false,
    isCollapsed: false,
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    setCollapsed: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockState.pathname,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mockState.invalidateQueries,
  }),
  useQuery: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
  })),
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => mockState.dateRangeState,
}));

vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: mockState.useKeyboardShortcuts,
}));

// SidebarContext: provide stable mock so Header and DashboardShell don't need
// a real SidebarProvider in test renders.
vi.mock("@/components/layout/SidebarContext", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSidebar: () => mockState.sidebarState,
}));

// MonthSelector: renders its own useDateRange call — simple stub avoids
// coupling the header tests to month-selector internals.
vi.mock("@/components/filters/MonthSelector", () => ({
  MonthSelector: () => <div data-testid="month-selector" />,
}));

function mockJsonResponse(payload: unknown) {
  return Promise.resolve({
    json: async () => payload,
  } as Response);
}

beforeEach(() => {
  mockState.pathname = "/dashboard";
  mockState.dateRangeState.mode = "preset";
  mockState.dateRangeState.days = 7;
  mockState.dateRangeState.startDate = "2024-01-01";
  mockState.dateRangeState.endDate = "2024-01-07";
  mockState.dateRangeState.period = null;
  mockState.dateRangeState.setDays.mockReset();
  mockState.dateRangeState.setCustomRange.mockReset();
  mockState.dateRangeState.setMonth.mockReset();
  mockState.invalidateQueries.mockReset();
  mockState.useKeyboardShortcuts.mockReset();
  mockState.sidebarState.toggle.mockReset();
  localStorage.clear();
  document.documentElement.className = "";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("layout coverage", () => {
  it("renders brand text, status badges, preset controls, and theme toggling", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sync" && !init?.method) {
        return mockJsonResponse({
          syncInProgress: false,
          status: [{ days_synced: 2 }, { days_synced: 3 }],
          autoSync: { enabled: true, utcTime: "05:00", nextRunAt: null },
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Header />);

    // Brand text is now a <p>, not an <h1> — the page title owns <h1> (#101)
    expect(screen.getByText("GitHub Copilot Usage Dashboard")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "GitHub Copilot Usage Dashboard" })
    ).not.toBeInTheDocument();

    // Desktop preset pills are rendered (jsdom doesn't apply responsive CSS)
    expect(screen.getByRole("button", { name: "28 days" })).toBeInTheDocument();

    await screen.findAllByText("5 days synced");
    expect(screen.getByText("Auto-sync 05:00 UTC")).toBeInTheDocument();

    // Month selector is present
    expect(screen.getByTestId("month-selector")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "28 days" }));
    expect(mockState.dateRangeState.setDays).toHaveBeenCalledWith(28);

    const themeToggle = screen.getByRole("button", { name: "Switch to dark theme" });
    fireEvent.click(themeToggle);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
  });

  it("hamburger button is present and calls sidebar toggle", async () => {
    const fetchMock = vi.fn(() =>
      mockJsonResponse({ syncInProgress: false, status: [] })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Header />);

    const hamburger = screen.getByRole("button", { name: "Open navigation menu" });
    expect(hamburger).toBeInTheDocument();
    fireEvent.click(hamburger);
    expect(mockState.sidebarState.toggle).toHaveBeenCalledTimes(1);
  });

  it("shows custom ranges and triggers sync requests", async () => {
    mockState.dateRangeState.mode = "custom";
    mockState.dateRangeState.startDate = "2024-02-01";
    mockState.dateRangeState.endDate = "2024-02-15";

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sync" && !init?.method) {
        return mockJsonResponse({ syncInProgress: false, status: [] });
      }
      if (String(input) === "/api/sync" && init?.method === "POST") {
        return mockJsonResponse({ started: true });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Header />);

    expect(screen.getByText("2024-02-01 — 2024-02-15")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Sync/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Starting sync...").length).toBeGreaterThanOrEqual(1);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sync", { method: "POST" });
  });

  it("renders sidebar groups using visibility config and highlights the active page", async () => {
    mockState.pathname = "/dashboard/ai-credits-users";
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return mockJsonResponse({
          pageVisibility: {
            billing: false,
            billingUsage: false,
            billingPremium: false,
            licenseReconciliation: false,
            cli: true,
            copilotApp: true,
          },
        });
      }
      if (String(input) === "/api/filters") {
        return mockJsonResponse({
          enterprises: [{ slug: "ent-a", displayName: "Enterprise A" }],
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);

    await screen.findByText("Enterprise A");
    // New 6-destination structure: "Usage" and "Cost & Licensing" replace old group labels
    expect(screen.getByText("Usage")).toBeInTheDocument();
    expect(screen.getByText("Cost & Licensing")).toBeInTheDocument();
    // All groups start expanded, so sub-items are immediately visible
    expect(screen.getByText("CLI Analytics").closest("a")).toHaveAttribute("href", "/dashboard/cli");
    expect(screen.getByText("Copilot App").closest("a")).toHaveAttribute("href", "/dashboard/copilot-app");
    // Active sub-item (ai-credits-users) carries border-l-2 highlight (#103 icon fix: label is now "Credits by User")
    expect(screen.getByText("Credits by User").closest("a")).toHaveAttribute("href", "/dashboard/ai-credits-users");
    expect(screen.getByText("Credits by User").closest("a")).toHaveClass("border-l-2");
    // Hidden items absent
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Credits")).not.toBeInTheDocument();
    // "License & Credits" old label no longer used (now "Reconciliation", and hidden by visKey)
    expect(screen.queryByText("License & Credits")).not.toBeInTheDocument();
    expect(screen.queryByText("Reconciliation")).not.toBeInTheDocument();
  });

  it("shows Reconciliation when its own page-visibility flag is enabled, independent of the other Cost & Licensing pages", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return mockJsonResponse({
          pageVisibility: {
            billing: false,
            billingUsage: false,
            billingPremium: false,
            licenseReconciliation: true,
          },
        });
      }
      if (String(input) === "/api/filters") {
        return mockJsonResponse({ enterprises: [] });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);

    const link = await screen.findByText("Reconciliation");
    expect(link.closest("a")).toHaveAttribute("href", "/dashboard/license-reconciliation");
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Credits")).not.toBeInTheDocument();
  });

  it("hides the Copilot App nav item when pageVisibility.copilotApp is false", async () => {
    mockState.pathname = "/dashboard/copilot-app";
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return mockJsonResponse({ pageVisibility: { copilotApp: false } });
      }
      if (String(input) === "/api/filters") {
        return mockJsonResponse({ enterprises: [] });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);

    await waitFor(() => {
      expect(screen.queryByText("Copilot App")).not.toBeInTheDocument();
    });
  });

  it("marks the Copilot App nav item active while on its detail page", async () => {
    mockState.pathname = "/dashboard/copilot-app";
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return mockJsonResponse({ pageVisibility: { copilotApp: true } });
      }
      if (String(input) === "/api/filters") {
        return mockJsonResponse({ enterprises: [] });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);

    const link = await screen.findByText("Copilot App");
    expect(link.closest("a")).toHaveAttribute("href", "/dashboard/copilot-app");
    // Active sub-items carry border-l-2 (consistent with top-level active links)
    expect(link.closest("a")).toHaveClass("border-l-2");
  });


  it("supports collapsed sidebar mode and multi-enterprise labels", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return mockJsonResponse({ pageVisibility: {} });
      }
      if (String(input) === "/api/filters") {
        return mockJsonResponse({
          enterprises: [
            { slug: "ent-a", displayName: "Enterprise A" },
            { slug: "ent-b", displayName: "Enterprise B" },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);

    // Multi-enterprise label
    await screen.findByText("2 enterprises");

    // Clicking "Collapse sidebar" delegates to setCollapsed(true) from useSidebar context.
    // The visual hiding of labels is the context's responsibility; here we verify the
    // sidebar correctly calls the context with the expected value.
    const collapseBtn = screen.getByRole("button", { name: "Collapse sidebar" });
    fireEvent.click(collapseBtn);
    expect(mockState.sidebarState.setCollapsed).toHaveBeenCalledWith(true);

    // When isCollapsed is true (as provided by the mock after update), text labels are hidden.
    // Simulate the context update by checking behaviour when isCollapsed starts true.
    mockState.sidebarState.setCollapsed.mockReset();
    cleanup();

    // Re-render with isCollapsed=true to test icon-only mode text hiding
    mockState.sidebarState.isCollapsed = true;
    render(<Sidebar />);

    await screen.findByRole("button", { name: "Expand sidebar" });
    expect(screen.queryByText("Overview")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage Analytics")).not.toBeInTheDocument();
    expect(screen.queryByText("2 enterprises")).not.toBeInTheDocument();

    // Restore for subsequent tests
    mockState.sidebarState.isCollapsed = false;
  });

  it("activates dashboard shell keyboard shortcuts", () => {
    render(
      <DashboardShell>
        <div>Shell content</div>
      </DashboardShell>,
    );

    expect(mockState.useKeyboardShortcuts).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Shell content")).toBeInTheDocument();
  });
});
