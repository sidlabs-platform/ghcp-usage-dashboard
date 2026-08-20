// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SeatLifecycleTrendChart } from "@/components/charts/SeatLifecycleTrendChart";

interface MockChartProps {
  children?: ReactNode;
  data?: unknown;
}

function makeMock(testId: string) {
  const MockChart = ({ children, data }: MockChartProps) => (
    <svg data-testid={testId} data-json={data ? JSON.stringify(data) : undefined}>
      {children}
    </svg>
  );
  MockChart.displayName = testId;
  return MockChart;
}

vi.mock("recharts", () => ({
  ResponsiveContainer: makeMock("ResponsiveContainer"),
  ComposedChart: makeMock("ComposedChart"),
  Bar: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(cleanup);

describe("SeatLifecycleTrendChart", () => {
  it("renders an empty state when there are no rows", () => {
    render(<SeatLifecycleTrendChart data={[]} />);
    expect(screen.getByText("No seat changes recorded in this window.")).toBeInTheDocument();
    expect(screen.queryByTestId("ComposedChart")).not.toBeInTheDocument();
  });

  it("renders the empty state when every day is zero", () => {
    render(
      <SeatLifecycleTrendChart
        data={[
          { day: "2025-06-01", onboarded: 0, offboarded: 0, net: 0 },
          { day: "2025-06-02", onboarded: 0, offboarded: 0, net: 0 },
        ]}
      />,
    );
    expect(screen.queryByTestId("ComposedChart")).not.toBeInTheDocument();
  });

  it("uses the caller-supplied empty message", () => {
    render(<SeatLifecycleTrendChart data={[]} emptyMessage="Loading…" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("plots offboarded counts as negative values against a shared zero baseline", () => {
    render(
      <SeatLifecycleTrendChart
        data={[
          { day: "2025-06-01", onboarded: 4, offboarded: 1, net: 3 },
          { day: "2025-06-02", onboarded: 0, offboarded: 2, net: -2 },
        ]}
      />,
    );

    const chart = screen.getByTestId("ComposedChart");
    const data = JSON.parse(chart.getAttribute("data-json") ?? "[]");
    expect(data).toEqual([
      { day: "2025-06-01", onboarded: 4, offboarded: 1, net: 3, offboardedNegative: -1 },
      { day: "2025-06-02", onboarded: 0, offboarded: 2, net: -2, offboardedNegative: -2 },
    ]);
  });
});
