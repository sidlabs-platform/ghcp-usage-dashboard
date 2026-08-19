import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const configState = vi.hoisted(() => ({
  isBillingSubEnabledForAnyEnterprise: vi.fn(),
  getEnterpriseSlugs: vi.fn(),
}));

const repoState = vi.hoisted(() => ({
  resetBillingSyncState: vi.fn(),
}));

vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));

vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: (...args: unknown[]) =>
    configState.isBillingSubEnabledForAnyEnterprise(...args),
  getEnterpriseSlugs: () => configState.getEnterpriseSlugs(),
}));

vi.mock("@/lib/db/billing-repo", () => ({
  resetBillingSyncState: (...args: unknown[]) => repoState.resetBillingSyncState(...args),
}));

import { POST } from "./route";

const post = (url: string) => POST(new NextRequest(url, { method: "POST" }));

beforeEach(() => {
  configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(true);
  configState.getEnterpriseSlugs.mockReturnValue(["ent-a", "ent-b"]);
  repoState.resetBillingSyncState.mockReturnValue(2);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("token backfill route", () => {
  it("clears sync state for every enterprise when none is specified", async () => {
    const res = await post("http://localhost/api/billing/tokens/backfill");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, cleared: 2, enterprise: "all" });
    expect(repoState.resetBillingSyncState).toHaveBeenCalledWith(
      ["ai_credit", "premium_request"],
      undefined
    );
  });

  it("scopes the reset to a configured enterprise", async () => {
    const res = await post("http://localhost/api/billing/tokens/backfill?enterprise=ent-b");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ enterprise: "ent-b" });
    expect(repoState.resetBillingSyncState).toHaveBeenCalledWith(
      ["ai_credit", "premium_request"],
      "ent-b"
    );
  });

  it("rejects an unknown enterprise instead of silently clearing nothing", async () => {
    const res = await post("http://localhost/api/billing/tokens/backfill?enterprise=nope");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Unknown enterprise "nope". Configured enterprises: ent-a, ent-b',
    });
    expect(repoState.resetBillingSyncState).not.toHaveBeenCalled();
  });

  it("treats a blank enterprise parameter as unscoped rather than invalid", async () => {
    const res = await post("http://localhost/api/billing/tokens/backfill?enterprise=%20%20");
    expect(res.status).toBe(200);
    expect(repoState.resetBillingSyncState).toHaveBeenCalledWith(
      ["ai_credit", "premium_request"],
      undefined
    );
  });

  it("returns 400 when no billing report type is enabled", async () => {
    configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(false);
    const res = await post("http://localhost/api/billing/tokens/backfill");
    expect(res.status).toBe(400);
    expect(repoState.resetBillingSyncState).not.toHaveBeenCalled();
  });

  it("does not leak the internal exception message on failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    repoState.resetBillingSyncState.mockImplementation(() => {
      throw new Error("SQLITE_ERROR: no such column: billing_sync_state.enterprise_slug");
    });
    const res = await post("http://localhost/api/billing/tokens/backfill");
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to clear billing sync state." });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
