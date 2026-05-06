import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/github/code-scanning-client", () => ({
  codeScanningClient: {
    getEnterpriseAlerts: vi.fn(async () => []),
    getOrgAlerts: vi.fn(async () => []),
    getAlertAutofixStatus: vi.fn(async () => null),
  },
}));

vi.mock("@/lib/github/dependabot-client", () => ({
  dependabotClient: {
    getEnterpriseAlerts: vi.fn(async () => []),
    getOrgAlerts: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/github/secret-scanning-client", () => ({
  secretScanningClient: {
    getEnterpriseAlerts: vi.fn(async () => []),
    getOrgAlerts: vi.fn(async () => []),
  },
}));

vi.mock("./ghas-repo", () => ({
  upsertCodeScanningAlerts: vi.fn(),
  upsertDependabotAlerts: vi.fn(),
  upsertSecretScanningAlerts: vi.fn(),
  recomputeCodeScanningDaily: vi.fn(),
  recomputeDependabotDaily: vi.fn(),
  recomputeSecretScanningDaily: vi.fn(),
  getGhasSyncState: vi.fn(() => null),
  updateGhasSyncState: vi.fn(),
  updateAlertAutofixStatuses: vi.fn(),
  promoteAutofixCommitted: vi.fn(),
  getOpenCodeScanningAlerts: vi.fn(() => []),
}));

vi.mock("./database", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ cnt: 5 })) })),
  })),
}));

vi.mock("@/lib/config/dashboard-config", () => ({
  isMetricEnabled: vi.fn(() => true),
  getSecurityConfig: vi.fn(() => ({ backfillDays: 90 })),
  isEnterpriseEnabled: vi.fn(() => true),
  isCodeScanningAutofixEnabled: vi.fn(() => false),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  getConfiguredEnterprises: vi.fn(() => [{ slug: "test-ent" }]),
  getResolvedOrgsForEnterprise: vi.fn(() => ["test-org"]),
}));

// Stub setTimeout to resolve immediately (the 2s inter-category delays)
vi.stubGlobal("setTimeout", (fn: () => void) => { fn(); return 0; });

import { fullGhasSync, incrementalGhasSync } from "./ghas-sync-service";
import { isMetricEnabled, isCodeScanningAutofixEnabled } from "@/lib/config/dashboard-config";
import { codeScanningClient } from "@/lib/github/code-scanning-client";
import { getGhasSyncState, getOpenCodeScanningAlerts } from "./ghas-repo";

describe("ghas-sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isMetricEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isCodeScanningAutofixEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it("fullGhasSync fetches all categories for enterprise + orgs", async () => {
    const result = await fullGhasSync(undefined, "test-ent");
    expect(Object.keys(result.categories)).toHaveLength(6);
    expect(result.errors).toBe(0);
  });

  it("skips disabled categories", async () => {
    (isMetricEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await fullGhasSync(undefined, "test-ent");
    for (const v of Object.values(result.categories)) {
      expect(v.alertsFetched).toBe(0);
    }
  });

  it("incrementalGhasSync delegates to fullGhasSync", async () => {
    const result = await incrementalGhasSync(undefined, "test-ent");
    expect(result.categories).toBeDefined();
  });

  it("handles API errors gracefully", async () => {
    (codeScanningClient.getEnterpriseAlerts as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("API failure"));
    const result = await fullGhasSync(undefined, "test-ent");
    expect(result.categories["enterprise:test-ent:code_scanning"]?.alertsFetched).toBe(0);
  });

  it("does incremental sync when prior state exists", async () => {
    const mockState = getGhasSyncState as ReturnType<typeof vi.fn>;
    mockState.mockReturnValue({
      last_alert_updated_at: "2025-01-01T00:00:00Z",
      total_alerts: 10,
    });
    (codeScanningClient.getEnterpriseAlerts as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ updated_at: "2025-01-02T00:00:00Z" }]);
    const result = await fullGhasSync(undefined, "test-ent");
    const cs = result.categories["enterprise:test-ent:code_scanning"];
    expect(cs?.isIncremental).toBe(true);
    expect(cs?.alertsFetched).toBe(1);
  });

  it("enriches autofix when enabled", async () => {
    (isCodeScanningAutofixEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getOpenCodeScanningAlerts as ReturnType<typeof vi.fn>).mockReturnValue([
      { alert_number: 1, repo_full_name: "org/repo" },
    ]);
    const result = await fullGhasSync(undefined, "test-ent");
    expect(result.categories["enterprise:test-ent:code_scanning"]).toBeDefined();
  });
});
