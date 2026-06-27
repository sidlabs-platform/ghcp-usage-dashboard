// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { DateRangeProvider, useDateRange } from "@/contexts/DateRangeContext";
import { ScopeProvider, useScope } from "@/contexts/ScopeContext";
import { DEFAULT_DATE_RANGE_DAYS } from "@/lib/constants";
import { MAX_DAYS } from "@/lib/utils";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

const mockedUseQuery = vi.mocked(useQuery);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function DateRangeConsumer() {
  const { mode, days, startDate, endDate, setDays, setCustomRange } = useDateRange();

  return (
    <div>
      <div data-testid="mode">{mode}</div>
      <div data-testid="days">{days}</div>
      <div data-testid="start">{startDate}</div>
      <div data-testid="end">{endDate}</div>
      <button type="button" onClick={() => setDays(MAX_DAYS + 100)}>Clamp days</button>
      <button type="button" onClick={() => setCustomRange("2025-01-01", "2025-01-10")}>Set custom range</button>
    </div>
  );
}

function ScopeConsumer() {
  const {
    filterOptions,
    selectedEnterprises,
    selectedEntTeams,
    selectedOrgTeams,
    selectedOrgs,
    setSelectedEnterprises,
    setSelectedEntTeams,
    setSelectedOrgTeams,
    setSelectedOrgs,
    clearAll,
    hasFilter,
    isMultiEnterprise,
    buildScopeParams,
  } = useScope();

  return (
    <div>
      <div data-testid="enterprise-count">{filterOptions.enterprises.length}</div>
      <div data-testid="is-multi-enterprise">{String(isMultiEnterprise)}</div>
      <div data-testid="params">{buildScopeParams().toString()}</div>
      <div data-testid="has-filter">{String(hasFilter)}</div>
      <div data-testid="selected-enterprises">{selectedEnterprises.join(",")}</div>
      <div data-testid="selected-ent-teams">{selectedEntTeams.join(",")}</div>
      <div data-testid="selected-org-teams">{selectedOrgTeams.join(",")}</div>
      <div data-testid="selected-orgs">{selectedOrgs.join(",")}</div>
      <button type="button" onClick={() => setSelectedEntTeams(["ent-a:platform-core"])}>Set enterprise team</button>
      <button type="button" onClick={() => setSelectedOrgTeams(["ent-b:app-team"])}>Set org team</button>
      <button type="button" onClick={() => setSelectedOrgs(["org-a"])}>Set org</button>
      <button type="button" onClick={() => setSelectedEnterprises(["ent-a"])}>Set enterprise</button>
      <button type="button" onClick={clearAll}>Clear all</button>
    </div>
  );
}

describe("DateRangeProvider", () => {
  it("tracks preset and custom date ranges", () => {
    render(
      <DateRangeProvider>
        <DateRangeConsumer />
      </DateRangeProvider>,
    );

    expect(screen.getByTestId("mode")).toHaveTextContent("preset");
    expect(screen.getByTestId("days")).toHaveTextContent(String(DEFAULT_DATE_RANGE_DAYS));

    fireEvent.click(screen.getByRole("button", { name: "Clamp days" }));
    expect(screen.getByTestId("days")).toHaveTextContent(String(MAX_DAYS));
    expect(screen.getByTestId("mode")).toHaveTextContent("preset");

    fireEvent.click(screen.getByRole("button", { name: "Set custom range" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("custom");
    expect(screen.getByTestId("start")).toHaveTextContent("2025-01-01");
    expect(screen.getByTestId("end")).toHaveTextContent("2025-01-10");
  });
});

describe("ScopeProvider", () => {
  it("loads filter options, builds params, prunes mismatched selections, and clears filters", async () => {
    mockedUseQuery.mockReturnValue({
      data: {
        enterprises: [
          { slug: "ent-a", displayName: "Enterprise A" },
          { slug: "ent-b", displayName: "Enterprise B" },
        ],
        enterpriseTeams: [
          { slug: "platform-core", name: "Platform Core", enterpriseSlug: "ent-a", memberCount: 12 },
        ],
        orgTeams: [
          { slug: "app-team", name: "App Team", enterpriseSlug: "ent-b", orgSlug: "org-b", memberCount: 7 },
        ],
        orgs: [
          { slug: "org-a", name: "Org A", enterpriseSlug: "ent-a" },
          { slug: "org-b", name: "Org B", enterpriseSlug: "ent-b" },
        ],
      },
    } as never);

    render(
      <ScopeProvider>
        <ScopeConsumer />
      </ScopeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("enterprise-count")).toHaveTextContent("2");
    });
    expect(screen.getByTestId("is-multi-enterprise")).toHaveTextContent("true");
    expect(screen.getByTestId("has-filter")).toHaveTextContent("false");

    fireEvent.click(screen.getByRole("button", { name: "Set enterprise team" }));
    expect(screen.getByTestId("params")).toHaveTextContent("teams=ent-a%3Aplatform-core");

    fireEvent.click(screen.getByRole("button", { name: "Set org team" }));
    expect(screen.getByTestId("params")).toHaveTextContent("teams=ent-a%3Aplatform-core%2Cent-b%3Aapp-team");

    fireEvent.click(screen.getByRole("button", { name: "Set enterprise" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-org-teams")).toHaveTextContent("");
    });
    expect(screen.getByTestId("selected-enterprises")).toHaveTextContent("ent-a");
    expect(screen.getByTestId("params").textContent).toContain("enterprises=ent-a");
    expect(screen.getByTestId("params").textContent).not.toContain("ent-b%3Aapp-team");

    fireEvent.click(screen.getByRole("button", { name: "Set org" }));
    expect(screen.getByTestId("params").textContent).toContain("orgs=org-a");

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByTestId("params")).toHaveTextContent("");
    expect(screen.getByTestId("has-filter")).toHaveTextContent("false");
  });
});
