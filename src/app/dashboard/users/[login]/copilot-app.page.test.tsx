// @vitest-environment jsdom
//
// Proves the user detail dashboard page's Copilot App attribution UI:
// - The "Copilot App" badge and "Copilot App Activity" section only render
//   when summary.usedCopilotApp is true (actual activity) — never for
//   "supported but unused" (false) or "no evidence" (null/undefined) cases.
// - The section's metric cards render the exact copilotAppStats fields.
// - The section includes an accessible heading and a link to
//   /dashboard/copilot-app.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ login: "octocat" }),
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => ({ mode: "preset", days: 7, startDate: "", endDate: "" }),
}));

vi.mock("@/components/layout/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock("@/components/filters/DateFilter", () => ({
  DateFilter: () => <div>Date Filter</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span data-testid="badge">{children}</span>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/cards/MetricCard", () => ({
  MetricCard: ({ title, value }: { title: string; value: React.ReactNode }) => (
    <section>
      <h3>{title}</h3>
      <span data-testid={`metric-${title}`}>{value}</span>
    </section>
  ),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
}));

const baseDailyActivity = [
  {
    day: "2024-01-01",
    codeGen: 10,
    codeAccept: 8,
    locSuggested: 100,
    locAccepted: 90,
    locSuggestedDelete: 2,
    locDeleted: 5,
    interactions: 20,
    aiCreditsUsed: 1,
    agentLocAdded: 0,
    agentLocDeleted: 0,
    completionLocSuggested: 100,
    completionLocAccepted: 90,
    completionLocDeleted: 5,
    completionLocSuggestedDelete: 2,
    appLocAdded: 0,
    appLocDeleted: 0,
  },
];

const baseSummary = {
  totalActiveDays: 1,
  totalLocAdded: 100,
  totalLocAccepted: 90,
  totalLocSuggestedDelete: 2,
  totalLocDeleted: 5,
  totalInteractions: 20,
  totalAiCreditsUsed: 1,
  totalCodeGen: 10,
  totalCodeAccept: 8,
  acceptanceRate: 80,
  agentLocAdded: 0,
  agentLocDeleted: 0,
  totalLocSuggested: 100,
  completionLocAccepted: 90,
  completionLocDeleted: 5,
  completionLocSuggestedDelete: 2,
  completionAcceptanceRate: 80,
  usedAgent: false,
  usedChat: false,
  usedCli: false,
  usedCodeReview: false,
  usedCodingAgent: false,
  usedCodeReviewPassive: false,
};

const baseResponse = {
  user: "octocat",
  dailyActivity: baseDailyActivity,
  topLanguages: [],
  topModels: [],
  ideUsage: [],
  featureUsage: [],
  chatModes: { agent: 0, ask: 0, edit: 0, plan: 0, custom: 0, unknown: 0 },
  cliStats: null,
};

const copilotAppStats = {
  sessions: 4,
  requests: 10,
  prompts: 12,
  promptTokens: 500,
  outputTokens: 300,
  avgTokensPerRequest: 80,
  codeGenerations: 7,
  codeAcceptances: 5,
  locAdded: 60,
  locDeleted: 8,
};

function stubFetch(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }),
  ) as unknown as typeof fetch);
}

describe("user detail page — Copilot App activity section", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("shows the Copilot App badge and activity section with exact stats when usedCopilotApp is true", async () => {
    stubFetch({
      ...baseResponse,
      summary: { ...baseSummary, usedCopilotApp: true },
      copilotAppStats,
    });

    const Page = (await import("./page")).default;
    await act(async () => {
      render(<Page />);
    });

    expect(screen.getByText("Copilot App")).toBeInTheDocument();
    expect(screen.getByText("Copilot App Activity")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View Copilot App Analytics/i })).toHaveAttribute(
      "href", "/dashboard/copilot-app",
    );

    // "Code Generations" is also used by the unrelated top-level KPI strip
    // (summary.totalCodeGen), so the App section's own card is asserted by
    // scoping the query within the "Copilot App Activity" section.
    const section = screen.getByText("Copilot App Activity").closest("div")!.parentElement as HTMLElement;
    expect(screen.getByTestId("metric-Sessions")).toHaveTextContent("4");
    expect(screen.getByTestId("metric-Requests")).toHaveTextContent("10");
    expect(screen.getByTestId("metric-Prompts")).toHaveTextContent("12");
    expect(screen.getByTestId("metric-Tokens / Request")).toHaveTextContent("80");
    expect(screen.getByTestId("metric-App LoC")).toHaveTextContent("60");
    const appCodeGenCard = Array.from(section.querySelectorAll('[data-testid="metric-Code Generations"]'))
      .find((el) => el.textContent === "7");
    expect(appCodeGenCard).toBeTruthy();
  });

  it("hides the Copilot App badge and section when usedCopilotApp is false (supported but unused)", async () => {
    stubFetch({
      ...baseResponse,
      summary: { ...baseSummary, usedCopilotApp: false },
      copilotAppStats: {
        sessions: 0, requests: 0, prompts: 0, promptTokens: 0, outputTokens: 0,
        avgTokensPerRequest: 0, codeGenerations: 0, codeAcceptances: 0, locAdded: 0, locDeleted: 0,
      },
    });

    const Page = (await import("./page")).default;
    await act(async () => {
      render(<Page />);
    });

    expect(screen.queryByText("Copilot App")).not.toBeInTheDocument();
    expect(screen.queryByText("Copilot App Activity")).not.toBeInTheDocument();
  });

  it("hides the Copilot App badge and section when usedCopilotApp is null (no support evidence / legacy data)", async () => {
    stubFetch({
      ...baseResponse,
      summary: { ...baseSummary, usedCopilotApp: null },
      copilotAppStats: null,
    });

    const Page = (await import("./page")).default;
    await act(async () => {
      render(<Page />);
    });

    expect(screen.queryByText("Copilot App")).not.toBeInTheDocument();
    expect(screen.queryByText("Copilot App Activity")).not.toBeInTheDocument();
  });

  it("hides the Copilot App badge/section when usedCopilotApp is omitted entirely (legacy API response)", async () => {
    stubFetch({
      ...baseResponse,
      summary: { ...baseSummary },
      copilotAppStats: null,
    });

    const Page = (await import("./page")).default;
    await act(async () => {
      render(<Page />);
    });

    expect(screen.queryByText("Copilot App")).not.toBeInTheDocument();
    expect(screen.queryByText("Copilot App Activity")).not.toBeInTheDocument();
  });
});
