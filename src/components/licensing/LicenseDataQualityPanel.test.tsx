// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { LicenseRunReportObject } from "@/lib/db/license-run-repo";
import { LicenseDataQualityPanel } from "./LicenseDataQualityPanel";

function makeReport(overrides: Partial<LicenseRunReportObject> = {}): LicenseRunReportObject {
  return {
    id: "run-1",
    enterpriseSlug: "acme",
    status: "success",
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:05:00.000Z",
    elapsedMs: 300_000,
    requestedPeriods: ["2026-05"],
    sourceStats: { rawSecret: "should-never-render" },
    sources: [
      {
        source: "seats_api",
        billingPeriod: "2026-05",
        status: "success",
        lastSyncedAt: "2026-06-01T00:00:00.000Z",
        coverageStart: "2026-05-01",
        coverageEnd: "2026-05-31",
        errorMessage: null,
      },
    ],
    checks: [
      { name: "seat_count", billingPeriod: "2026-05", orgLogin: "acme-org", status: "pass", message: "OK", expectedValue: 10, actualValue: 10, details: {} },
      { name: "real_login_coverage", billingPeriod: "2026-05", orgLogin: "acme-org", status: "warning", message: "Some unresolved", expectedValue: null, actualValue: null, details: {} },
    ],
    checkCounts: { pass: 1, warning: 1, fail: 0 },
    unresolvedIdentities: [{ holderKey: "holder-unresolved-1", reason: "no_login" }],
    warnings: ["2 unresolved identities"],
    errorMessage: null,
    diagnostics: {
      materializedRowCount: 42,
      activeSeatRowCount: 40,
      consumptionRowCount: 38,
      consumedCredits: 500,
      consumedUsd: 50,
      identityResolution: { bySource: [{ source: "seat_login", count: 40 }], unresolvedHolderKeys: ["holder-unresolved-1"] },
      historyCoverage: [{ confidence: "exact_snapshot", count: 40 }],
      sourceStateSummary: [{ source: "seats_api", periods: [{ billingPeriod: "2026-05", status: "success", lastSyncedAt: "2026-06-01T00:00:00.000Z" }] }],
      apiRequestCounts: { total: 12, bySource: { seats_api: 12 } },
    },
    ...overrides,
  };
}

describe("LicenseDataQualityPanel", () => {
  afterEach(() => cleanup());

  it("renders pass/warning/fail badges with text, not color alone", () => {
    render(
      <LicenseDataQualityPanel
        coverage={{ mode: "historical", periods: ["2026-05"], view: "detail" }}
        warnings={[]}
        report={makeReport()}
        reportLoading={false}
        reportError={null}
      />,
    );
    expect(screen.getByText(/1 pass/i)).toBeInTheDocument();
    expect(screen.getByText(/1 warning/i)).toBeInTheDocument();
    expect(screen.getByText(/0 fail/i)).toBeInTheDocument();
    expect(screen.getByText("seat_count")).toBeInTheDocument();
    expect(screen.getByText("real_login_coverage")).toBeInTheDocument();
  });

  it("shows a limitation message (not a success message) when no run/report is available", () => {
    render(
      <LicenseDataQualityPanel
        coverage={{ mode: "historical", periods: ["2026-05"], view: "detail" }}
        warnings={[]}
        report={null}
        reportLoading={false}
        reportError={null}
      />,
    );
    expect(screen.getByText(/no reconciliation run/i)).toBeInTheDocument();
    expect(screen.queryByText(/success/i)).not.toBeInTheDocument();
  });

  it("renders source coverage summaries and history confidence counts", () => {
    render(
      <LicenseDataQualityPanel
        coverage={{ mode: "historical", periods: ["2026-05"], view: "detail" }}
        warnings={[]}
        report={makeReport()}
        reportLoading={false}
        reportError={null}
      />,
    );
    expect(screen.getByText("seats_api")).toBeInTheDocument();
    expect(screen.getByText(/exact_snapshot/)).toBeInTheDocument();
    expect(screen.getAllByText(/40/).length).toBeGreaterThan(0);
  });

  it("renders a bounded, collapsible safe unresolved holder key list without unsafe fields", () => {
    render(
      <LicenseDataQualityPanel
        coverage={{ mode: "historical", periods: ["2026-05"], view: "detail" }}
        warnings={[]}
        report={makeReport()}
        reportLoading={false}
        reportError={null}
      />,
    );
    const details = screen.getByText(/Unresolved holders/i).closest("details");
    expect(details).toBeTruthy();
    expect(screen.getByText("holder-unresolved-1")).toBeInTheDocument();
    expect(screen.queryByText(/rawSecret/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/should-never-render/i)).not.toBeInTheDocument();
  });

  it("shows API request/row counts and warnings", () => {
    render(
      <LicenseDataQualityPanel
        coverage={{ mode: "historical", periods: ["2026-05"], view: "detail" }}
        warnings={["scope narrowed"]}
        report={makeReport()}
        reportLoading={false}
        reportError={null}
      />,
    );
    expect(screen.getByText(/42/)).toBeInTheDocument();
    expect(screen.getByText(/scope narrowed/i)).toBeInTheDocument();
    expect(screen.getByText(/2 unresolved identities/i)).toBeInTheDocument();
  });

  it("shows a loading state distinct from success/limitation", () => {
    render(
      <LicenseDataQualityPanel
        coverage={null}
        warnings={[]}
        report={null}
        reportLoading={true}
        reportError={null}
      />,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error state", () => {
    render(
      <LicenseDataQualityPanel
        coverage={null}
        warnings={[]}
        report={null}
        reportLoading={false}
        reportError="Failed to load run report"
      />,
    );
    expect(screen.getByText(/Failed to load run report/i)).toBeInTheDocument();
  });
});
