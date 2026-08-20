import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getCodeScanningDaily = vi.hoisted(() => vi.fn(() => []));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: (params: URLSearchParams) => ({
    selectedTeams: params.get("teams")?.split(",").filter(Boolean) ?? [],
    selectedOrgs: params.get("orgs")?.split(",").filter(Boolean) ?? [],
    selectedEnterprises: params.get("enterprises")?.split(",").filter(Boolean) ?? [],
    hasFilter: false,
  }),
}));

vi.mock("@/lib/db/ghas-repo", () => ({
  getCodeScanningDaily,
  getDependabotDaily: vi.fn(() => []),
  getSecretScanningDaily: vi.fn(() => []),
  getSecurityOverview: vi.fn(() => ({})),
  computeMTTR: vi.fn(() => null),
}));

vi.mock("@/lib/aggregation/ghas-aggregation", () => ({
  computeSecuritySummary: vi.fn(() => ({})),
  formatMTTR: vi.fn(() => "—"),
}));

vi.mock("@/lib/config/dashboard-config", () => ({
  isMetricEnabled: vi.fn((metric: string) => metric === "codeScanning"),
  isEnterpriseEnabled: vi.fn(() => false),
  getResolvedOrgs: vi.fn(() => ["octodemo"]),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  resolveDefaultScope: vi.fn(() => ({ scope: "enterprise", scopeId: "ent1" })),
}));

import { GET } from "./route";

describe("security overview date range", () => {
  beforeEach(() => {
    getCodeScanningDaily.mockClear();
  });

  it("uses an explicit calendar range when provided", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/security/overview?startDate=2026-07-01&endDate=2026-07-31",
    ));

    expect(response.status).toBe(200);
    expect(getCodeScanningDaily).toHaveBeenCalledWith(
      "org",
      "octodemo",
      "2026-07-01",
      "2026-07-31",
    );
    expect(await response.json()).toMatchObject({
      dataAsOf: "2026-07-31",
      daysLoaded: 31,
    });
  });

  it("uses a single selected organization as the security scope", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/security/overview?days=7&orgs=selected-org",
    ));

    expect(response.status).toBe(200);
    expect(getCodeScanningDaily).toHaveBeenCalledWith(
      "org",
      "selected-org",
      expect.any(String),
      expect.any(String),
    );
  });

  it("rejects team filters because GHAS data cannot be filtered by user membership", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/security/overview?days=7&teams=ent1:platform&orgs=octodemo",
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Security metrics do not support team filters. Clear the team selection to view security data.",
    });
    expect(getCodeScanningDaily).not.toHaveBeenCalled();
  });

  it("rejects simultaneous organization and enterprise selections", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/security/overview?days=7&orgs=octodemo&enterprises=ent1",
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Security metrics support either one organization or one enterprise, not both.",
    });
  });
});
