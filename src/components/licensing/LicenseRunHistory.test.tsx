// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LicenseRunHistory } from "./LicenseRunHistory";

function mockJsonResponse(payload: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => payload,
  } as Response);
}

function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    enterpriseSlug: "acme",
    status: "success",
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:05:00.000Z",
    elapsedMs: 300_000,
    requestedPeriods: ["2026-05"],
    checkCounts: { pass: 5, warning: 1, fail: 0 },
    warningCount: 1,
    hasError: false,
    ...overrides,
  };
}

function runReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    enterpriseSlug: "acme",
    status: "success",
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:05:00.000Z",
    elapsedMs: 300_000,
    requestedPeriods: ["2026-05"],
    sourceStats: {},
    sources: [],
    checks: [],
    checkCounts: { pass: 5, warning: 1, fail: 0 },
    unresolvedIdentities: [],
    warnings: [],
    errorMessage: null,
    diagnostics: {
      materializedRowCount: 0,
      activeSeatRowCount: 0,
      consumptionRowCount: 0,
      consumedCredits: 0,
      consumedUsd: 0,
      identityResolution: { bySource: [], unresolvedHolderKeys: [] },
      historyCoverage: [],
      sourceStateSummary: [],
      apiRequestCounts: { total: 0, bySource: {} },
    },
    ...overrides,
  };
}

describe("LicenseRunHistory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("fetches and renders a deterministic recent run list for the active enterprise", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("/runs?")) {
        return mockJsonResponse({ enterprise: "acme", runs: [runSummary()] });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LicenseRunHistory enterpriseSlug="acme" selectedRunId={null} onSelectRun={vi.fn()} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />);

    await screen.findByText(/run-1/i);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("enterprise=acme"), expect.anything());
    expect(screen.getByText(/success/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-05/)).toBeInTheDocument();
  });

  it("fetches run detail on selection and reports it via onReportChange", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?")) {
        return mockJsonResponse({ enterprise: "acme", runs: [runSummary()] });
      }
      if (url.includes("/runs/run-1")) {
        return mockJsonResponse(runReport());
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onSelectRun = vi.fn();
    const onReportChange = vi.fn();
    render(
      <LicenseRunHistory
        enterpriseSlug="acme"
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onReportChange={onReportChange}
        onReportErrorChange={vi.fn()}
      />,
    );

    const row = await screen.findByRole("button", { name: /run-1/i });
    fireEvent.click(row);
    expect(onSelectRun).toHaveBeenCalledWith("run-1");

    await waitFor(() => {
      expect(onReportChange).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1" }));
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/runs/run-1?enterprise=acme"), expect.anything());
  });

  it("marks the selected run with aria-current", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?")) {
        return mockJsonResponse({ enterprise: "acme", runs: [runSummary()] });
      }
      return mockJsonResponse(runReport());
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LicenseRunHistory enterpriseSlug="acme" selectedRunId="run-1" onSelectRun={vi.fn()} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />,
    );

    const row = await screen.findByRole("button", { name: /run-1/i });
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("supports keyboard activation of a run row", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?")) {
        return mockJsonResponse({ enterprise: "acme", runs: [runSummary()] });
      }
      return mockJsonResponse(runReport());
    });
    vi.stubGlobal("fetch", fetchMock);

    const onSelectRun = vi.fn();
    render(
      <LicenseRunHistory enterpriseSlug="acme" selectedRunId={null} onSelectRun={onSelectRun} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />,
    );
    const row = await screen.findByRole("button", { name: /run-1/i });
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelectRun).toHaveBeenCalledWith("run-1");
  });

  it("shows an empty state when there is no enterprise selected", () => {
    render(<LicenseRunHistory enterpriseSlug={null} selectedRunId={null} onSelectRun={vi.fn()} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />);
    expect(screen.getByText(/select an enterprise/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => mockJsonResponse({ enterprise: "acme", runs: [] })),
    );
    render(<LicenseRunHistory enterpriseSlug="acme" selectedRunId={null} onSelectRun={vi.fn()} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />);
    await screen.findByText(/no reconciliation runs/i);
  });

  it("shows an error state with retry on list fetch failure", async () => {
    const fetchMock = vi.fn(() => mockJsonResponse({ error: "boom" }, false));
    vi.stubGlobal("fetch", fetchMock);
    render(<LicenseRunHistory enterpriseSlug="acme" selectedRunId={null} onSelectRun={vi.fn()} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />);
    await screen.findByText(/failed to load/i);
    const retry = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("guards against stale responses when the enterprise changes quickly", async () => {
    let resolveFirst: (value: Response) => void = () => {};
    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("enterprise=first")) return firstPromise;
      if (url.includes("enterprise=second")) {
        return mockJsonResponse({ enterprise: "second", runs: [runSummary({ id: "run-second", enterpriseSlug: "second" })] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <LicenseRunHistory enterpriseSlug="first" selectedRunId={null} onSelectRun={vi.fn()} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />,
    );
    rerender(
      <LicenseRunHistory enterpriseSlug="second" selectedRunId={null} onSelectRun={vi.fn()} onReportChange={vi.fn()} onReportErrorChange={vi.fn()} />,
    );

    await screen.findByText(/run-second/i);

    // The stale "first" response resolving late must not clobber the "second" list.
    resolveFirst({
      ok: true,
      json: async () => ({ enterprise: "first", runs: [runSummary({ id: "run-first-stale" })] }),
    } as Response);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/run-first-stale/i)).not.toBeInTheDocument();
    expect(screen.getByText(/run-second/i)).toBeInTheDocument();
  });

  it("ignores a stale run-detail response after the enterprise changes", async () => {
    let resolveFirstDetail: (value: Response) => void = () => {};
    const firstDetail = new Promise<Response>((resolve) => {
      resolveFirstDetail = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?enterprise=first")) {
        return mockJsonResponse({ enterprise: "first", runs: [runSummary({ enterpriseSlug: "first" })] });
      }
      if (url.includes("/runs/run-1?enterprise=first")) return firstDetail;
      if (url.includes("/runs?enterprise=second")) {
        return mockJsonResponse({ enterprise: "second", runs: [runSummary({ id: "run-second", enterpriseSlug: "second" })] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onReportChange = vi.fn();

    const { rerender } = render(
      <LicenseRunHistory
        enterpriseSlug="first"
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onReportChange={onReportChange}
        onReportErrorChange={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /run-1/i }));

    rerender(
      <LicenseRunHistory
        enterpriseSlug="second"
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onReportChange={onReportChange}
        onReportErrorChange={vi.fn()}
      />,
    );
    await screen.findByText(/run-second/i);

    resolveFirstDetail({
      ok: true,
      json: async () => runReport({ enterpriseSlug: "first" }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onReportChange).not.toHaveBeenCalledWith(expect.objectContaining({ enterpriseSlug: "first" }));
  });

  it("surfaces a run-detail failure with an actionable retry", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?")) {
        return mockJsonResponse({ enterprise: "acme", runs: [runSummary()] });
      }
      return mockJsonResponse({ error: "boom" }, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onReportChange = vi.fn();
    const onReportErrorChange = vi.fn();

    render(
      <LicenseRunHistory
        enterpriseSlug="acme"
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onReportChange={onReportChange}
        onReportErrorChange={onReportErrorChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /run-1/i }));
    await screen.findByText(/failed to load run report/i);
    expect(onReportChange).toHaveBeenCalledWith(null);
    expect(onReportErrorChange).toHaveBeenCalledWith(expect.stringMatching(/failed to load/i));

    fireEvent.click(screen.getByRole("button", { name: /retry run report/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});
