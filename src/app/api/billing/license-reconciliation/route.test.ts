import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const repoState = vi.hoisted(() => ({
  getLicenseReconciliationRows: vi.fn(),
  computeLicenseKPIs: vi.fn(),
  computePlanBreakdown: vi.fn(),
  computeOrgBreakdown: vi.fn(),
  computeUtilizationBuckets: vi.fn(),
  sortLicenseRows: vi.fn(),
}));

const configState = vi.hoisted(() => ({
  isBillingSubEnabledForAnyEnterprise: vi.fn(),
  getLicensingConfig: vi.fn(),
}));

const scopeState = vi.hoisted(() => ({
  parseScopeFilter: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/utils", () => ({
  parseAndClampDays: vi.fn(() => ({ days: 28 })),
  getDateRange: vi.fn(() => ({ start: "2026-06-01", end: "2026-06-28" })),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: (...args: unknown[]) =>
    configState.isBillingSubEnabledForAnyEnterprise(...args),
}));

// Keep the real `LicensingConfigError` class (route.ts checks `instanceof`
// against it) but let the test control what `getLicensingConfig` returns/throws.
vi.mock("@/lib/config/dashboard-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config/dashboard-config")>(
    "@/lib/config/dashboard-config"
  );
  return {
    ...actual,
    getLicensingConfig: (...args: unknown[]) => configState.getLicensingConfig(...args),
  };
});

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: (...args: unknown[]) => scopeState.parseScopeFilter(...args),
}));

vi.mock("@/lib/db/license-repo", () => ({
  getLicenseReconciliationRows: (...a: unknown[]) => repoState.getLicenseReconciliationRows(...a),
  computeLicenseKPIs: (...a: unknown[]) => repoState.computeLicenseKPIs(...a),
  computePlanBreakdown: (...a: unknown[]) => repoState.computePlanBreakdown(...a),
  computeOrgBreakdown: (...a: unknown[]) => repoState.computeOrgBreakdown(...a),
  computeUtilizationBuckets: (...a: unknown[]) => repoState.computeUtilizationBuckets(...a),
  sortLicenseRows: (...a: unknown[]) => repoState.sortLicenseRows(...a),
}));

import { GET } from "./route";
import { LicensingConfigError } from "@/lib/config/dashboard-config";

function req(url = "http://localhost/api/billing/license-reconciliation?days=28"): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(true);
  scopeState.parseScopeFilter.mockReturnValue({ allowedLogins: undefined, enterpriseSlugs: undefined });
  repoState.getLicenseReconciliationRows.mockReturnValue([]);
  repoState.computeLicenseKPIs.mockReturnValue({});
  repoState.computePlanBreakdown.mockReturnValue([]);
  repoState.computeOrgBreakdown.mockReturnValue([]);
  repoState.computeUtilizationBuckets.mockReturnValue([]);
  repoState.sortLicenseRows.mockReturnValue([]);
  configState.getLicensingConfig.mockReturnValue({ currency: "USD", creditToUsd: 0.01 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("license reconciliation route", () => {
  it("returns 200 with the resolved licensing config when it is valid", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.config).toEqual({ currency: "USD", creditToUsd: 0.01 });
  });

  it("returns a stable 422 invalid_licensing_config response with the exact validation details, and no stack trace or extra fields, when licensing config is invalid", async () => {
    const details = [
      'licensing.history.reportMonths ("not-a-month") is invalid: Invalid report month "not-a-month": expected format YYYY-MM',
      "licensing.creditToUsd must be a non-negative finite number (got -1)",
    ];
    configState.getLicensingConfig.mockImplementation(() => {
      throw new LicensingConfigError(details);
    });

    const res = await GET(req());
    expect(res.status).toBe(422);
    const body = await res.json();

    // Stable, minimal shape: exactly `error` + `details`, nothing else (no
    // `stack`, `message`, file paths, or other internals leaked).
    expect(Object.keys(body).sort()).toEqual(["details", "error"]);
    expect(body.error).toBe("invalid_licensing_config");
    expect(body.details).toEqual(details);
  });

  it("does not use the licensing 422 shape for unrelated errors, and does not leak their message", async () => {
    repoState.getLicenseReconciliationRows.mockImplementation(() => {
      throw new Error("db connection exploded: password=hunter2");
    });

    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("returns enabled:false and skips getLicensingConfig when billing is disabled", async () => {
    configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: false });
    expect(configState.getLicensingConfig).not.toHaveBeenCalled();
  });
});
