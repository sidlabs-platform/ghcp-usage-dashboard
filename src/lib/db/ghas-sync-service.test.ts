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
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { codeScanningClient } from "@/lib/github/code-scanning-client";

describe("ghas-sync-service", () => {
  beforeEach(() => { vi.clearAllMocks(); });

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
});
