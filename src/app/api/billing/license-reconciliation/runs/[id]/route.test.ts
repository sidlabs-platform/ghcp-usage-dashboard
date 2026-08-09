import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const runRepoState = vi.hoisted(() => ({
  getLicenseRun: vi.fn(),
  listLicenseChecks: vi.fn(),
  listLicenseSourceState: vi.fn(),
}));

const enterpriseConfigState = vi.hoisted(() => ({
  getEnterpriseSlugs: vi.fn(),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  getEnterpriseSlugs: (...a: unknown[]) => enterpriseConfigState.getEnterpriseSlugs(...a),
}));

vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));

vi.mock("@/lib/db/license-run-repo", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/license-run-repo")>("@/lib/db/license-run-repo");
  return {
    ...actual,
    getLicenseRun: (...a: unknown[]) => runRepoState.getLicenseRun(...a),
    listLicenseChecks: (...a: unknown[]) => runRepoState.listLicenseChecks(...a),
    listLicenseSourceState: (...a: unknown[]) => runRepoState.listLicenseSourceState(...a),
  };
});

import { GET } from "./route";

function req(url: string): NextRequest {
  return new NextRequest(url);
}

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    enterpriseSlug: "acme",
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:05:00.000Z",
    status: "success",
    requestedPeriods: ["2026-06"],
    sourceStats: { secretToken: "ghp_abcdefghijklmnopqrstuvwxyz012345" },
    unresolvedIdentities: [],
    warnings: [],
    errorMessage: null,
    ...overrides,
  };
}

beforeEach(() => {
  enterpriseConfigState.getEnterpriseSlugs.mockReturnValue(["acme", "other-ent"]);
  runRepoState.getLicenseRun.mockReturnValue(null);
  runRepoState.listLicenseChecks.mockReturnValue([]);
  runRepoState.listLicenseSourceState.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("license reconciliation run detail route", () => {
  it("returns 400 when enterprise is missing", async () => {
    const res = await GET(req("http://localhost/api/billing/license-reconciliation/runs/run-1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when enterprise is unknown", async () => {
    const res = await GET(
      req("http://localhost/api/billing/license-reconciliation/runs/run-1?enterprise=unknown-ent"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown run id", async () => {
    runRepoState.getLicenseRun.mockReturnValue(null);
    const res = await GET(req("http://localhost/api/billing/license-reconciliation/runs/nope?enterprise=acme"));
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 200/403 with leaked data) when the run belongs to a different enterprise than requested", async () => {
    runRepoState.getLicenseRun.mockReturnValue(makeRun({ enterpriseSlug: "other-ent" }));
    const res = await GET(req("http://localhost/api/billing/license-reconciliation/runs/run-1?enterprise=acme"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("other-ent");
  });

  it("returns the sanitized buildLicenseRunReport object as JSON by default, never raw sourceStats", async () => {
    runRepoState.getLicenseRun.mockReturnValue(makeRun());
    const res = await GET(req("http://localhost/api/billing/license-reconciliation/runs/run-1?enterprise=acme"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("run-1");
    expect(body.enterpriseSlug).toBe("acme");
    expect(body.checkCounts).toEqual({ pass: 0, warning: 0, fail: 0 });
    expect(JSON.stringify(body)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(body.sourceStats.secretToken).toBe("[REDACTED_TOKEN]");
  });

  it("returns text/plain when format=text is requested", async () => {
    runRepoState.getLicenseRun.mockReturnValue(makeRun());
    const res = await GET(
      req("http://localhost/api/billing/license-reconciliation/runs/run-1?enterprise=acme&format=text"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain("run-1");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
  });

  it("rejects an invalid format value with a descriptive 400", async () => {
    runRepoState.getLicenseRun.mockReturnValue(makeRun());
    const res = await GET(
      req("http://localhost/api/billing/license-reconciliation/runs/run-1?enterprise=acme&format=xml"),
    );
    expect(res.status).toBe(400);
  });

  it("sets private no-store/no-cache headers", async () => {
    runRepoState.getLicenseRun.mockReturnValue(makeRun());
    const res = await GET(req("http://localhost/api/billing/license-reconciliation/runs/run-1?enterprise=acme"));
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(res.headers.get("Cache-Control")).toMatch(/private/);
  });
});
