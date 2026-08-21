// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CustomRangeFilter } from "@/components/filters/CustomRangeFilter";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { MAX_DAYS } from "@/lib/utils";

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: vi.fn(),
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: vi.fn(),
}));

const mockedUseDateRange = vi.mocked(useDateRange);
const mockedUseScope = vi.mocked(useScope);

function mockCustomRangeFilter(setCustomRange = vi.fn()) {
  mockedUseDateRange.mockReturnValue({
    mode: "preset",
    days: 7,
    startDate: "",
    endDate: "",
    setDays: vi.fn(),
    setCustomRange,
  } as never);
  return setCustomRange;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("filter components", () => {
  it("validates custom date ranges", () => {
    const setDays = vi.fn();
    const setCustomRange = vi.fn();
    mockedUseDateRange.mockReturnValue({
      mode: "preset",
      days: 7,
      startDate: "",
      endDate: "",
      setDays,
      setCustomRange,
    } as never);

    render(<CustomRangeFilter />);

    fireEvent.click(screen.getByRole("button", { name: "Custom Range" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Both dates are required.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2025-01-10" } });
    fireEvent.change(screen.getByLabelText("End Date"), { target: { value: "2025-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Start date must be before end date.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2024-01-01" } });
    fireEvent.change(screen.getByLabelText("End Date"), { target: { value: "2025-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText(`Range cannot exceed ${MAX_DAYS} days.`)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("End Date"), { target: { value: "2025-01-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(setCustomRange).toHaveBeenCalledWith("2025-01-01", "2025-01-10");
  });

  it("rejects a custom start date after yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    const setCustomRange = mockCustomRangeFilter();

    render(<CustomRangeFilter />);

    fireEvent.click(screen.getByRole("button", { name: "Custom Range" }));
    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2026-08-21" } });
    fireEvent.change(screen.getByLabelText("End Date"), { target: { value: "2026-08-21" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText("Dates cannot be later than yesterday.")).toBeInTheDocument();
    expect(setCustomRange).not.toHaveBeenCalled();
  });

  it("rejects a custom end date after yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    const setCustomRange = mockCustomRangeFilter();

    render(<CustomRangeFilter />);

    fireEvent.click(screen.getByRole("button", { name: "Custom Range" }));
    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2026-08-20" } });
    fireEvent.change(screen.getByLabelText("End Date"), { target: { value: "2026-08-21" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByText("Dates cannot be later than yesterday.")).toBeInTheDocument();
    expect(setCustomRange).not.toHaveBeenCalled();
  });

  it("accepts a custom range ending yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    const setCustomRange = mockCustomRangeFilter();

    render(<CustomRangeFilter />);

    fireEvent.click(screen.getByRole("button", { name: "Custom Range" }));
    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2026-08-14" } });
    fireEvent.change(screen.getByLabelText("End Date"), { target: { value: "2026-08-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.queryByText("Dates cannot be later than yesterday.")).toBeNull();
    expect(setCustomRange).toHaveBeenCalledWith("2026-08-14", "2026-08-20");
  });

  it("sets the date input max to yesterday in the local calendar", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 21, 0, 30));
    mockCustomRangeFilter();

    render(<CustomRangeFilter />);

    fireEvent.click(screen.getByRole("button", { name: "Custom Range" }));

    expect(screen.getByLabelText("Start Date")).toHaveAttribute("max", "2026-08-20");
    expect(screen.getByLabelText("End Date")).toHaveAttribute("max", "2026-08-20");
  });

  it("renders and filters multi-enterprise scope selections", () => {
    const setSelectedEnterprises = vi.fn();
    const setSelectedEntTeams = vi.fn();
    const setSelectedOrgTeams = vi.fn();
    const setSelectedOrgs = vi.fn();

    mockedUseScope.mockReturnValue({
      filterOptions: {
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
      selectedEnterprises: [],
      selectedEntTeams: [],
      selectedOrgTeams: [],
      selectedOrgs: [],
      setSelectedEnterprises,
      setSelectedEntTeams,
      setSelectedOrgTeams,
      setSelectedOrgs,
      clearAll: vi.fn(),
      hasFilter: false,
      isMultiEnterprise: true,
      buildScopeParams: () => new URLSearchParams(),
    } as never);

    render(<ScopeFilter />);

    expect(screen.getByRole("button", { name: /Enterprise:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Enterprise Team:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Organization:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Org Team:/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Enterprise Team:/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: "platform" } });
    fireEvent.click(screen.getByRole("button", { name: /Platform Core \(ent-a\)/ }));
    expect(setSelectedEntTeams).toHaveBeenCalledWith(["ent-a:platform-core"]);
  });

  it("clears all scope selections and supports org-only mode", () => {
    const setSelectedEnterprises = vi.fn();
    const setSelectedEntTeams = vi.fn();
    const setSelectedOrgTeams = vi.fn();
    const setSelectedOrgs = vi.fn();

    mockedUseScope.mockReturnValue({
      filterOptions: {
        enterprises: [{ slug: "ent-a", displayName: "Enterprise A" }],
        enterpriseTeams: [{ slug: "platform-core", name: "Platform Core", enterpriseSlug: "ent-a", memberCount: 12 }],
        orgTeams: [{ slug: "app-team", name: "App Team", enterpriseSlug: "ent-a", orgSlug: "org-a", memberCount: 7 }],
        orgs: [{ slug: "org-a", name: "Org A", enterpriseSlug: "ent-a" }],
      },
      selectedEnterprises: [],
      selectedEntTeams: ["platform-core"],
      selectedOrgTeams: ["app-team"],
      selectedOrgs: ["org-a"],
      setSelectedEnterprises,
      setSelectedEntTeams,
      setSelectedOrgTeams,
      setSelectedOrgs,
      clearAll: vi.fn(),
      hasFilter: true,
      isMultiEnterprise: false,
      buildScopeParams: () => new URLSearchParams("orgs=org-a"),
    } as never);

    const { rerender } = render(<ScopeFilter />);
    fireEvent.click(screen.getByRole("button", { name: /Clear all filters/ }));
    expect(setSelectedEnterprises).toHaveBeenCalledWith([]);
    expect(setSelectedEntTeams).toHaveBeenCalledWith([]);
    expect(setSelectedOrgTeams).toHaveBeenCalledWith([]);
    expect(setSelectedOrgs).toHaveBeenCalledWith([]);

    rerender(<ScopeFilter orgOnly />);
    expect(screen.getByRole("button", { name: /Organization:/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enterprise Team:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Org Team:/ })).toBeNull();
  });
});
