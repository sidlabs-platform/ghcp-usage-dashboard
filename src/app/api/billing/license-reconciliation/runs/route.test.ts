import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const runRepoState = vi.hoisted(() => ({
  listLicenseRuns: vi.fn(),
  listLicenseChecks: vi.fn(),
  listLicenseSourceState: vi.fn(),
  getLicenseCheckCountsByRunIds: vi.fn(),
  buildLicenseRunReport: vi.fn(),
}));

const enterpriseConfigState = vi.hoisted(() => ({
  getEnterpriseSlugs: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/config/enterprise-config", () => ({
  getEnterpriseSlugs: (...a: unknown[]) => enterpriseConfigState.getEnterpriseSlugs(...a),
}));

vi.mock("@/lib/db/license-run-repo", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/license-run-repo")>("@/lib/db/license-run-repo");
  return {
    ...actual,
    listLicenseRuns: (...a: unknown[]) => runRepoState.listLicenseRuns(...a),
    listLicenseChecks: (...a: unknown[]) => runRepoState.listLicenseChecks(...a),
    listLicenseSourceState: (...a: unknown[]) => runRepoState.listLicenseSourceState(...a),
    getLicenseCheckCountsByRunIds: (...a: unknown[]) => runRepoState.getLicenseCheckCountsByRunIds(...a),
    buildLicenseRunReport: (...a: unknown[]) => runRepoState.buildLicenseRunReport(...a),
  };
});

import { GET } from "./route";

function req(url: string): NextRequest {
  return new NextRequest(url);
}

const BASE_URL = "http://localhost/api/billing/license-reconciliation/runs";

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    enterpriseSlug: "acme",
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:05:00.000Z",
    status: "success",
    requestedPeriods: ["2026-06"],
    sourceStats: { secretToken: "hunter2" },
    unresolvedIdentities: [],
    warnings: ["low confidence for org X"],
    errorMessage: null,
    ...overrides,
  };
}

beforeEach(() => {
  enterpriseConfigState.getEnterpriseSlugs.mockReturnValue(["acme", "other-ent"]);
  runRepoState.listLicenseRuns.mockReturnValue([]);
  runRepoState.listLicenseChecks.mockReturnValue([]);
  runRepoState.listLicenseSourceState.mockReturnValue([]);
  runRepoState.getLicenseCheckCountsByRunIds.mockReturnValue(new Map());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("license reconciliation runs list route", () => {
  it("returns 400 when enterprise is missing", async () => {
    const res = await GET(req(BASE_URL));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/enterprise/i);
  });

  it("returns 400 when enterprise is not a configured/known enterprise slug", async () => {
    const res = await GET(req(`${BASE_URL}?enterprise=unknown-ent`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/enterprise/i);
  });

  it("returns a valid empty array when the enterprise has no runs", async () => {
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toEqual([]);
  });

  it("returns deterministic recent runs with a safe summary shape, excluding raw sourceStats/checks/identities", async () => {
    runRepoState.listLicenseRuns.mockReturnValue([makeRun()]);
    runRepoState.listLicenseChecks.mockReturnValue([
      { runId: "run-1", checkName: "seat-count", billingPeriod: "2026-06", orgLogin: "acme-org", status: "pass", expectedValue: 1, actualValue: 1, message: "ok", details: {} },
    ]);
    runRepoState.getLicenseCheckCountsByRunIds.mockReturnValue(new Map([
      ["run-1", { pass: 1, warning: 0, fail: 0 }],
    ]));
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    const run = body.runs[0];
    expect(run).toMatchObject({
      id: "run-1",
      enterpriseSlug: "acme",
      status: "success",
      startedAt: "2026-06-01T00:00:00.000Z",
      completedAt: "2026-06-01T00:05:00.000Z",
      requestedPeriods: ["2026-06"],
    });
    expect(run.checkCounts).toEqual({ pass: 1, warning: 0, fail: 0 });
    // Never expose raw/unsanitized sourceStats, individual check records, or
    // unresolved-identity records in the list summary.
    expect(run.sourceStats).toBeUndefined();
    expect(run.checks).toBeUndefined();
    expect(run.sources).toBeUndefined();
    expect(run.unresolvedIdentities).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(runRepoState.getLicenseCheckCountsByRunIds).toHaveBeenCalledOnce();
    expect(runRepoState.getLicenseCheckCountsByRunIds).toHaveBeenCalledWith(["run-1"]);
    expect(runRepoState.listLicenseChecks).not.toHaveBeenCalled();
    expect(runRepoState.listLicenseSourceState).not.toHaveBeenCalled();
    expect(runRepoState.buildLicenseRunReport).not.toHaveBeenCalled();
  });

  it("validates and clamps the limit parameter", async () => {
    await GET(req(`${BASE_URL}?enterprise=acme&limit=5`));
    expect(runRepoState.listLicenseRuns).toHaveBeenCalledWith("acme", 5);

    await GET(req(`${BASE_URL}?enterprise=acme&limit=99999`));
    const secondCallLimit = runRepoState.listLicenseRuns.mock.calls[1][1];
    expect(secondCallLimit).toBeLessThanOrEqual(100);
  });

  it("rejects an invalid (non-numeric) limit with a descriptive 400", async () => {
    const res = await GET(req(`${BASE_URL}?enterprise=acme&limit=abc`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/limit/i);
  });

  it("rejects a fractional limit (e.g. 1.5) with a descriptive 400 rather than silently truncating", async () => {
    const res = await GET(req(`${BASE_URL}?enterprise=acme&limit=1.5`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/limit/i);
    expect(body.error).toMatch(/integer/i);
    expect(runRepoState.listLicenseRuns).not.toHaveBeenCalled();
  });

  it("sets a private, non-shared cache header", async () => {
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.headers.get("Cache-Control")).toMatch(/private/);
  });
});
