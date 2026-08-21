// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const tableState = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => ({ mode: "preset", days: 28, startDate: "", endDate: "" }),
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => ({
    hasFilter: false,
    buildScopeParams: () => new URLSearchParams(),
  }),
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

vi.mock("@/components/filters/ScopeFilter", () => ({
  ScopeFilter: () => <div>Scope Filter</div>,
}));

vi.mock("@/components/cards/MetricCard", () => ({
  MetricCard: ({ title, value, subtitle }: { title: string; value: React.ReactNode; subtitle?: string }) => (
    <section>
      <h2>{title}</h2>
      <span>{value}</span>
      {subtitle && <p>{subtitle}</p>}
    </section>
  ),
}));

vi.mock("@/components/ui/ExportMenu", () => ({
  ExportMenu: () => <button type="button">Export</button>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/tables/PaginatedTable", () => ({
  PaginatedTable: (props: Record<string, unknown>) => {
    tableState.props = props;
    return <div>Paginated AI Credits table</div>;
  },
}));

describe("AI Credits users page", () => {
  afterEach(() => {
    cleanup();
    tableState.props = undefined;
  });

  it("renders a sortable user consumption table backed by the AI Credits users API", async () => {
    const Page = (await import("./page")).default;
    render(<Page />);

    expect(screen.getByRole("heading", { name: "AI Credits by User" })).toBeInTheDocument();
    expect(screen.getByText("Scope Filter")).toBeInTheDocument();
    expect(screen.getByText("Paginated AI Credits table")).toBeInTheDocument();
    expect(tableState.props).toMatchObject({
      fetchUrl: "/api/billing/ai-credits/users",
      defaultSort: "total_ai_credits_used",
      queryKey: "ai-credits-users-table",
      searchable: true,
      searchPlaceholder: "Search users...",
    });
  });
});
