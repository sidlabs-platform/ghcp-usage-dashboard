// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import type { LicensePeriodRowRecord, LicenseRollupRowRecord } from "@/lib/db/license-history-repo";
import type { LicenseReconciliationRow } from "@/lib/types/licensing";
import { LicenseReconciliationTable } from "./LicenseReconciliationTable";

function detailRow(overrides: Partial<LicensePeriodRowRecord> = {}): LicensePeriodRowRecord {
  return {
    enterpriseSlug: "acme",
    billingPeriod: "2026-05",
    orgLogin: "acme-org",
    holderKey: "holder-1",
    githubUserId: 1,
    userLogin: "octocat",
    resolvedUserLogin: "octocat",
    externalIdentity: null,
    identityResolutionSource: "seat_login",
    accountState: "member",
    licenseAssignedDate: "2026-05-01",
    userRevokedDate: null,
    planType: "enterprise",
    seatStatus: "active",
    assignedVia: "direct",
    lastActivityAt: "2026-05-20",
    licenseCost: 39,
    defaultAicCredits: 100,
    defaultAicUsd: 10,
    aicAssignedUsd: 10,
    aicAssignedRule: "plan_default",
    aicConsumedCredits: 50,
    aicConsumedUsd: 5,
    currency: "USD",
    rowSource: "materialized",
    consumptionSource: "aic_csv",
    historyConfidence: "exact_snapshot",
    dataQualityNotes: [],
    asOfUtc: "2026-05-31T00:00:00.000Z",
    generatedAtUtc: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function rollupRow(overrides: Partial<LicenseRollupRowRecord> = {}): LicenseRollupRowRecord {
  return {
    enterpriseSlug: "acme",
    resolvedUserLogin: "octocat",
    periods: ["2026-04", "2026-05"],
    orgLogins: ["acme-org", "other-org"],
    planTypes: ["enterprise"],
    seatCount: 2,
    orgCount: 2,
    periodCount: 2,
    licenseCost: 78,
    defaultAicCredits: 200,
    defaultAicUsd: 20,
    aicAssignedUsd: 20,
    aicConsumedCredits: 100,
    aicConsumedUsd: 10,
    utilizationPct: 50,
    currency: "USD",
    historyConfidence: "exact_snapshot",
    ...overrides,
  };
}

function legacyRow(overrides: Partial<LicenseReconciliationRow> = {}): LicenseReconciliationRow {
  return {
    user_login: "octocat",
    orgs: ["acme-org"],
    org_count: 1,
    seat_count: 1,
    plan_type: "enterprise",
    license_assigned_date: "2026-05-01",
    last_activity_at: "2026-05-20",
    activity_status: "active_30d",
    assigned_via: "direct",
    user_status: "active",
    seat_status: "active",
    user_revoked_date: null,
    license_cost: 39,
    default_aic_credits: 100,
    default_aic_usd: 10,
    aic_assigned_usd: 10,
    aic_assigned_rule: "plan_default",
    aic_consumed_credits: 50,
    aic_consumed_usd: 5,
    utilization_pct: 50,
    over_budget: false,
    total_cost: 44,
    ...overrides,
  };
}

const basePagination = { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 };

describe("LicenseReconciliationTable", () => {
  afterEach(() => cleanup());

  it("renders detail-view provenance columns", () => {
    render(
      <LicenseReconciliationTable
        view="detail"
        rows={[detailRow()]}
        currency="USD"
        sort="total_cost"
        sortDir="desc"
        onSort={vi.fn()}
        pagination={basePagination}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("acme-org")).toBeInTheDocument();
    expect(screen.getByText("2026-05")).toBeInTheDocument();
    expect(screen.getByText("seat_login")).toBeInTheDocument();
    expect(screen.getByText("exact_snapshot")).toBeInTheDocument();
    expect(screen.getByText("aic_csv")).toBeInTheDocument();
  });

  it("renders rollup-view aggregate columns without inventing values", () => {
    render(
      <LicenseReconciliationTable
        view="rollup"
        rows={[rollupRow({ seatCount: 3 })]}
        currency="USD"
        sort="license_cost"
        sortDir="desc"
        onSort={vi.fn()}
        pagination={basePagination}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // org count
    expect(screen.getByText("2026-04 – 2026-05")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("shows Unresolved with a stable holder key and never an external identity", () => {
    render(
      <LicenseReconciliationTable
        view="detail"
        rows={[
          detailRow({
            resolvedUserLogin: null,
            userLogin: null,
            holderKey: "holder-unresolved-1",
            identityResolutionSource: "unresolved",
            externalIdentity: "secret@example.com",
          }),
        ]}
        currency="USD"
        sort="total_cost"
        sortDir="desc"
        onSort={vi.fn()}
        pagination={basePagination}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Unresolved")).toBeInTheDocument();
    expect(screen.getByText("holder-unresolved-1")).toBeInTheDocument();
    expect(screen.queryByText("secret@example.com")).not.toBeInTheDocument();
  });

  it("renders legacy live-snapshot rows without provenance columns", () => {
    render(
      <LicenseReconciliationTable
        view="legacy"
        rows={[legacyRow()]}
        currency="USD"
        sort="total_cost"
        sortDir="desc"
        onSort={vi.fn()}
        pagination={basePagination}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("acme-org")).toBeInTheDocument();
  });

  it("only allows sorting on supported fields and marks aria-sort", () => {
    const onSort = vi.fn();
    render(
      <LicenseReconciliationTable
        view="detail"
        rows={[detailRow()]}
        currency="USD"
        sort="license_cost"
        sortDir="asc"
        onSort={onSort}
        pagination={basePagination}
        onPageChange={vi.fn()}
      />,
    );
    const header = screen.getByRole("columnheader", { name: /License cost/i });
    expect(header).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: /License cost/i }));
    expect(onSort).toHaveBeenCalledWith("license_cost");
  });

  it("uses stable multi-org row keys without React duplicate-key warnings", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <LicenseReconciliationTable
        view="detail"
        rows={[
          detailRow({ orgLogin: "org-a", holderKey: "holder-1" }),
          detailRow({ orgLogin: "org-b", holderKey: "holder-1" }),
        ]}
        currency="USD"
        sort="total_cost"
        sortDir="desc"
        onSort={vi.fn()}
        pagination={{ ...basePagination, totalItems: 2 }}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByText("org-a")).toBeInTheDocument();
    expect(screen.getByText("org-b")).toBeInTheDocument();
    const duplicateKeyWarning = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("same key")),
    );
    expect(duplicateKeyWarning).toBe(false);
    warnSpy.mockRestore();
  });

  it("renders server pagination with counts and Previous/Next controls", () => {
    const onPageChange = vi.fn();
    render(
      <LicenseReconciliationTable
        view="detail"
        rows={[detailRow()]}
        currency="USD"
        sort="total_cost"
        sortDir="desc"
        onSort={vi.fn()}
        pagination={{ page: 2, pageSize: 50, totalItems: 120, totalPages: 3 }}
        onPageChange={onPageChange}
      />,
    );
    expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    expect(screen.getByText(/120/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("renders a descriptive empty row when there are no matching rows", () => {
    render(
      <LicenseReconciliationTable
        view="detail"
        rows={[]}
        currency="USD"
        sort="total_cost"
        sortDir="desc"
        onSort={vi.fn()}
        pagination={{ page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/No matching rows/i)).toBeInTheDocument();
  });
});
