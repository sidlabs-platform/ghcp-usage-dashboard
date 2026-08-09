// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AlertTriangle } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { ChartErrorBoundary } from "@/components/states/ChartErrorBoundary";
import { EmptyState } from "@/components/states/EmptyState";
import { ChartSkeleton, KPISkeleton } from "@/components/states/ChartSkeleton";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/charts/Sparkline", () => ({
  Sparkline: ({ data, color }: { data: number[]; color: string }) => (
    <div data-testid="sparkline" data-color={color}>
      {data.join(",")}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("core UI coverage", () => {
  it("renders section headers and children", () => {
    render(
      <Section title="Metrics" description="Executive summary" className="custom-section">
        <div>child content</div>
      </Section>,
    );

    expect(screen.getByText("Metrics")).toBeInTheDocument();
    expect(screen.getByText("Executive summary")).toBeInTheDocument();
    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(document.querySelector(".custom-section")).not.toBeNull();
  });

  it("renders page headers with optional actions", () => {
    render(
      <PageHeader title="Billing" description="Spend trends">
        <button type="button">Export</button>
      </PageHeader>,
    );

    expect(screen.getByRole("heading", { name: "Billing" })).toBeInTheDocument();
    expect(screen.getByText("Spend trends")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("renders metric cards with formatting, delta, and sparkline background", () => {
    render(
      <MetricCard
        title="Acceptance Rate"
        value={84.5}
        format="percent"
        delta={{ value: -1.2 }}
        subtitle="Trailing 28 days"
        accent="amber"
        trend={[10, 20, 30]}
        trendColor="#abc123"
        icon={<span>icon</span>}
      />,
    );

    expect(screen.getByText("Acceptance Rate")).toBeInTheDocument();
    expect(screen.getByText("84.5%")).toBeInTheDocument();
    expect(screen.getByText("-1.2%")).toBeInTheDocument();
    expect(screen.getByText("Trailing 28 days")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline")).toHaveTextContent("10,20,30");
    expect(screen.getByText("icon")).toBeInTheDocument();
  });

  it("renders format=\"raw\" numeric values as exact locale-formatted integers, not abbreviated", () => {
    // Regression test: format="raw" must show the exact value (e.g. 3456 ->
    // "3,456"), never an abbreviated form (e.g. "3.5K") — abbreviation is
    // only correct for the default "number" format.
    render(<MetricCard title="Weighted Tokens / Request" value={3456} format="raw" />);

    expect(screen.getByText("3,456")).toBeInTheDocument();
    expect(screen.queryByText("3.5K")).not.toBeInTheDocument();
  });

  it("still abbreviates large values for the default \"number\" format", () => {
    render(<MetricCard title="Requests" value={3456} />);

    expect(screen.getByText("3.5K")).toBeInTheDocument();
  });

  it("renders chart tooltips only when active and formats labels and values", () => {
    const inactive = render(
      <ChartTooltip
        active={false}
        payload={[{ name: "Users", value: 12, color: "#000", dataKey: "users" }]}
      />,
    );
    expect(inactive.container.firstChild).toBeNull();

    render(
      <ChartTooltip
        active
        label="2025-06-01"
        labelFormatter={(label) => `Day ${label}`}
        valueFormatter={(value, name) => `${name}: ${value}`}
        payload={[{ name: "Users", value: 12, color: "#000", dataKey: "users" }]}
      />,
    );

    expect(screen.getByText("Day 2025-06-01")).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("Users: 12")).toBeInTheDocument();
  });

  it("shows a fallback when a chart subtree throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => {
      throw new Error("boom");
    };

    render(
      <ChartErrorBoundary>
        <Boom />
      </ChartErrorBoundary>,
    );

    expect(screen.getByText("Failed to render this section")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalled();
  });

  it("renders empty states with link and callback actions", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <EmptyState
        icon={AlertTriangle}
        title="No seats"
        description="Sync data to populate this page."
        action={{ label: "Open docs", href: "/docs" }}
      />,
    );

    expect(screen.getByText("No seats")).toBeInTheDocument();
    expect(screen.getByText("Sync data to populate this page.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open docs →" })).toHaveAttribute("href", "/docs");

    rerender(
      <EmptyState
        icon={AlertTriangle}
        title="Still empty"
        description="Try syncing again."
        action={{ label: "Retry sync", onClick }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders chart and KPI skeleton placeholders", () => {
    const { container } = render(
      <div>
        <ChartSkeleton />
        <KPISkeleton />
      </div>,
    );

    expect(container.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);
  });
});
