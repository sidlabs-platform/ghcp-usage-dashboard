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
    mode: "preset" as "preset" | "custom",
    days: 7,
    startDate: "2024-01-01",
    endDate: "2024-01-07",
    setDays: vi.fn(),
    setCustomRange: vi.fn(),
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

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockState.invalidateQueries,
    }),
  };
});

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => mockState.dateRangeState,
}));

vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: mockState.useKeyboardShortcuts,
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
  mockState.dateRangeState.setDays.mockReset();
  mockState.dateRangeState.setCustomRange.mockReset();
  mockState.invalidateQueries.mockReset();
  mockState.useKeyboardShortcuts.mockReset();
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
  it("renders header status badges, preset controls, and theme toggling", async () => {
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

    expect(screen.getByRole("heading", { name: "GitHub Copilot Usage Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "28 days" })).toBeInTheDocument();

    await screen.findByText("5 days synced");
    expect(screen.getByText("Auto-sync 05:00 UTC")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "28 days" }));
    expect(mockState.dateRangeState.setDays).toHaveBeenCalledWith(28);

    const themeToggle = screen.getByRole("button", { name: "Switch to dark theme" });
    fireEvent.click(themeToggle);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Sync" }));

    await waitFor(() => {
      expect(screen.getByText("Starting sync...")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Syncing..." })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/sync", { method: "POST" });
  });

  it("renders sidebar groups using visibility config and highlights the active page", async () => {
    mockState.pathname = "/dashboard/cli";
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/config") {
        return mockJsonResponse({
          pageVisibility: {
            billing: false,
            billingUsage: false,
            billingPremium: false,
            cli: true,
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
    expect(screen.getByText("Usage Analytics")).toBeInTheDocument();
    expect(screen.getByText("CLI Analytics").closest("a")).toHaveAttribute("href", "/dashboard/cli");
    expect(screen.getByText("CLI Analytics").closest("a")).toHaveClass("border-l-2");
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Credits")).not.toBeInTheDocument();
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

    await screen.findByText("2 enterprises");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.queryByText("Usage Analytics")).not.toBeInTheDocument();
    expect(screen.queryByText("Overview")).not.toBeInTheDocument();
    expect(screen.queryByText("2 enterprises")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
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
