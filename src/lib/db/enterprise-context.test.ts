import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config/enterprise-config", () => ({
  getEnterpriseConfig: vi.fn(() => ({
    slug: "ent1",
    displayName: "Enterprise 1",
    organizations: { include: ["org1"], exclude: [] },
  })),
  getEnterpriseAuth: vi.fn(() => ({ token: "tok1" })),
  getConfiguredEnterprises: vi.fn(() => [{ slug: "ent1" }, { slug: "ent2" }]),
}));

vi.mock("@/lib/db/database", () => {
  const mockDb = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ enterprise_id: "eid-123" })),
      run: vi.fn(),
    })),
  };
  return { getDb: () => mockDb };
});

import { getEnterpriseContext, getAllEnterpriseContexts, updateEnterpriseRegistry } from "./enterprise-context";

describe("enterprise-context", () => {
  it("getEnterpriseContext returns context with null enterprise_id when db not available", () => {
    const ctx = getEnterpriseContext("ent1");
    expect(ctx.slug).toBe("ent1");
    expect(ctx.displayName).toBe("Enterprise 1");
    expect(ctx.enterpriseId).toBeNull();
    expect(ctx.organizations.include).toEqual(["org1"]);
  });

  it("getAllEnterpriseContexts returns array of contexts", () => {
    const contexts = getAllEnterpriseContexts();
    expect(contexts).toHaveLength(2);
  });

  it("updateEnterpriseRegistry upserts without error", () => {
    expect(() => updateEnterpriseRegistry("ent1", "eid-456", "My Ent")).not.toThrow();
  });
});
