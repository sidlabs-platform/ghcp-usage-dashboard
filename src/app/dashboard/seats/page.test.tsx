// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { CSVColumn } from "@/lib/export/csv";
import type { ColumnDef } from "@/components/tables/PaginatedTable";

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
    startDate: "2024-06-01",
    endDate: "2024-06-30",
    period: null,
  } as DateState,
}));

const tableState = vi.hoisted(() => ({
  columns: [] as Array<ColumnDef<unknown>[]>,
}));

const exportState = vi.hoisted(() => ({
  columns: [] as CSVColumn[][],
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => dateState.value,
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => ({
    buildScopeParams: () => new URLSearchParams(),
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("lucide-react", () => ({
  CreditCard: () => <span data-testid="credit-card-icon" />,
  UserCheck: () => <span data-testid="user-check-icon" />,
  UserX: () => <span data-testid="user-x-icon" />,
  Percent: () => <span data-testid="percent-icon" />,
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
    value: number | string;
    subtitle?: string;
  }) => (
    <div>
      <span>{title}</span>
      <span data-testid={`metric-${title}`}>{value}</span>
      {subtitle && <span>{subtitle}</span>}
    </div>
  ),
}));

vi.mock("@/components/tables/PaginatedTable", () => ({
  PaginatedTable: ({ columns }: { columns: ColumnDef<unknown>[] }) => {
    tableState.columns.push(columns);
    return <div data-testid="seats-table" />;
  },
}));

vi.mock("@/components/ui/ExportMenu", () => ({
  ExportMenu: ({ csv }: { csv?: { columns: CSVColumn[] } }) => {
    if (csv) exportState.columns.push(csv.columns);
    return <button type="button">Export</button>;
  },
}));

function renderPage(fetchImpl = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    seats: [],
    stats: {
      total: 0,
      active30d: 0,
      inactive30d: 0,
      pendingCancellation: 0,
      activitySince: "2024-06-01T00:00:00.000Z",
      activityUntil: "2024-06-30T23:59:59.999Z",
    },
    utilization: 0,
    pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
  }),
} as Response))) {
  vi.stubGlobal(
    "fetch",
    fetchImpl,
  );

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return import("./page").then(({ default: Page }) => {
    const ui = (
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>
    );
    const result = render(ui);
    return {
      ...result,
      rerenderPage: () =>
        result.rerender(
          <QueryClientProvider client={queryClient}>
            <Page />
          </QueryClientProvider>,
        ),
    };
  });
}

describe("Seat Management page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
    dateState.value = {
      mode: "preset",
      days: 30,
      startDate: "2024-06-01",
      endDate: "2024-06-30",
      period: null,
    };
    tableState.columns = [];
    exportState.columns = [];
  });

  it("keeps fallback cutoff-based columns stable across loading rerenders", async () => {
    vi.useFakeTimers();
    const pendingFetch = vi.fn(() => new Promise<Response>(() => {}));

    try {
      vi.setSystemTime(new Date("2024-07-01T00:00:00.000Z"));
      const { rerenderPage } = await renderPage(pendingFetch);
      const firstTableColumns = tableState.columns.at(-1);
      const firstExportColumns = exportState.columns.at(-1);

      vi.setSystemTime(new Date("2024-07-01T00:00:01.000Z"));
      rerenderPage();

      expect(tableState.columns.at(-1)).toBe(firstTableColumns);
      expect(exportState.columns.at(-1)).toBe(firstExportColumns);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps month-mode labels capitalized in seat activity copy", async () => {
    dateState.value = {
      mode: "month",
      days: 30,
      startDate: "2024-06-01",
      endDate: "2024-06-30",
      period: "2024-06",
    };

    await renderPage();

    const text = document.body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("Activity split window: June 2024");
    expect(screen.getByText("Used during June 2024")).toBeTruthy();
    expect(screen.queryByText(/june 2024/)).toBeNull();
  });
});
