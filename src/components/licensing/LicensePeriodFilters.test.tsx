// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

const dateRangeState = vi.hoisted(() => ({
  mode: "preset" as "preset" | "custom",
  days: 28,
  startDate: "2026-05-01",
  endDate: "2026-05-28",
}));

const scopeState = vi.hoisted(() => ({
  hasFilter: false,
  selectedEntTeams: [] as string[],
  selectedOrgTeams: [] as string[],
  selectedOrgs: [] as string[],
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => dateRangeState,
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => scopeState,
}));

import {
  LicensePeriodFilters,
  PLAN_TYPE_OPTIONS,
  ACCOUNT_STATE_OPTIONS,
  SEAT_STATUS_OPTIONS,
  HISTORY_CONFIDENCE_OPTIONS,
} from "./LicensePeriodFilters";

function baseProps(overrides: Partial<React.ComponentProps<typeof LicensePeriodFilters>> = {}) {
  return {
    view: "detail" as const,
    onViewChange: vi.fn(),
    periods: [],
    onPeriodsChange: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
    planTypes: [],
    onPlanTypesChange: vi.fn(),
    accountStates: [],
    onAccountStatesChange: vi.fn(),
    seatStatuses: [],
    onSeatStatusesChange: vi.fn(),
    historyConfidence: [],
    onHistoryConfidenceChange: vi.fn(),
    onClearFilters: vi.fn(),
    ...overrides,
  };
}

describe("LicensePeriodFilters", () => {
  afterEach(() => {
    cleanup();
    dateRangeState.mode = "preset";
    dateRangeState.days = 28;
    dateRangeState.startDate = "2026-05-01";
    dateRangeState.endDate = "2026-05-28";
    scopeState.hasFilter = false;
    scopeState.selectedEntTeams = [];
    scopeState.selectedOrgTeams = [];
    scopeState.selectedOrgs = [];
  });

  it("shows the preset date range from DateRangeContext", () => {
    dateRangeState.mode = "preset";
    dateRangeState.days = 28;
    render(<LicensePeriodFilters {...baseProps()} />);
    expect(screen.getByText(/Last 28 days/i)).toBeInTheDocument();
  });

  it("shows the custom date range from DateRangeContext", () => {
    dateRangeState.mode = "custom";
    dateRangeState.startDate = "2026-01-01";
    dateRangeState.endDate = "2026-01-15";
    render(<LicensePeriodFilters {...baseProps()} />);
    expect(screen.getByText(/2026-01-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-01-15/)).toBeInTheDocument();
  });

  it("notes that explicit periods override the date range when present", () => {
    render(<LicensePeriodFilters {...baseProps({ periods: ["2026-02", "2026-01"] })} />);
    expect(screen.getByText(/override/i)).toBeInTheDocument();
    // Sorted, deduped, rendered as chips
    const chips = screen.getAllByText(/^2026-0[12]$/);
    expect(chips.map((c) => c.textContent)).toEqual(["2026-01", "2026-02"]);
  });

  it("adds a valid explicit month, sorts, and dedupes on add", () => {
    const onPeriodsChange = vi.fn();
    render(<LicensePeriodFilters {...baseProps({ periods: ["2026-02"], onPeriodsChange })} />);
    const monthInput = screen.getByLabelText(/Add billing period/i);
    fireEvent.change(monthInput, { target: { value: "2026-01" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    expect(onPeriodsChange).toHaveBeenCalledWith(["2026-01", "2026-02"]);
  });

  it("ignores an invalid month format on add", () => {
    const onPeriodsChange = vi.fn();
    render(<LicensePeriodFilters {...baseProps({ onPeriodsChange })} />);
    const monthInput = screen.getByLabelText(/Add billing period/i);
    fireEvent.change(monthInput, { target: { value: "not-a-month" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    expect(onPeriodsChange).not.toHaveBeenCalled();
  });

  it("removes a period chip and clears all periods", () => {
    const onPeriodsChange = vi.fn();
    render(<LicensePeriodFilters {...baseProps({ periods: ["2026-01", "2026-02"], onPeriodsChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove 2026-01/i }));
    expect(onPeriodsChange).toHaveBeenCalledWith(["2026-02"]);

    fireEvent.click(screen.getByRole("button", { name: /Clear periods/i }));
    expect(onPeriodsChange).toHaveBeenCalledWith([]);
  });

  it("toggles the detail/rollup view", () => {
    const onViewChange = vi.fn();
    render(<LicensePeriodFilters {...baseProps({ view: "detail", onViewChange })} />);
    fireEvent.click(screen.getByRole("button", { name: "Rollup" }));
    expect(onViewChange).toHaveBeenCalledWith("rollup");
  });

  it("updates search", () => {
    const onSearchChange = vi.fn();
    render(<LicensePeriodFilters {...baseProps({ onSearchChange })} />);
    fireEvent.change(screen.getByLabelText(/Search users or organizations/i), { target: { value: "acme" } });
    expect(onSearchChange).toHaveBeenCalledWith("acme");
  });

  it("toggles enum filters matching the API allowlists", () => {
    const onPlanTypesChange = vi.fn();
    const onAccountStatesChange = vi.fn();
    const onSeatStatusesChange = vi.fn();
    const onHistoryConfidenceChange = vi.fn();
    render(
      <LicensePeriodFilters
        {...baseProps({ onPlanTypesChange, onAccountStatesChange, onSeatStatusesChange, onHistoryConfidenceChange })}
      />,
    );

    expect(PLAN_TYPE_OPTIONS).toEqual(["business", "enterprise", "unknown"]);
    expect(ACCOUNT_STATE_OPTIONS).toEqual(["unknown", "member", "suspended", "deprovisioned"]);
    expect(SEAT_STATUS_OPTIONS).toEqual(["active", "inactive", "no_seat"]);
    expect(HISTORY_CONFIDENCE_OPTIONS).toEqual([
      "exact_snapshot",
      "audit_reconstructed",
      "live_snapshot_only",
      "unrecoverable",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "enterprise" }));
    expect(onPlanTypesChange).toHaveBeenCalledWith(["enterprise"]);

    fireEvent.click(screen.getByRole("button", { name: "suspended" }));
    expect(onAccountStatesChange).toHaveBeenCalledWith(["suspended"]);

    fireEvent.click(screen.getByRole("button", { name: "no_seat" }));
    expect(onSeatStatusesChange).toHaveBeenCalledWith(["no_seat"]);

    fireEvent.click(screen.getByRole("button", { name: "audit_reconstructed" }));
    expect(onHistoryConfidenceChange).toHaveBeenCalledWith(["audit_reconstructed"]);
  });

  it("un-toggles an already-selected enum filter value", () => {
    const onPlanTypesChange = vi.fn();
    render(<LicensePeriodFilters {...baseProps({ planTypes: ["enterprise"], onPlanTypesChange })} />);
    fireEvent.click(screen.getByRole("button", { name: "enterprise" }));
    expect(onPlanTypesChange).toHaveBeenCalledWith([]);
  });

  it("calls onClearFilters and shows current scope status without duplicating the global control", () => {
    scopeState.hasFilter = true;
    scopeState.selectedOrgs = ["acme-org"];
    const onClearFilters = vi.fn();
    render(<LicensePeriodFilters {...baseProps({ onClearFilters })} />);
    expect(screen.getByText(/acme-org/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/i }));
    expect(onClearFilters).toHaveBeenCalled();
  });

  it("gives every input an accessible label", () => {
    render(<LicensePeriodFilters {...baseProps()} />);
    expect(screen.getByLabelText(/Search users or organizations/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Add billing period/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Plan/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Account state/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Seat status/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /History confidence/i })).toBeInTheDocument();
  });
});
