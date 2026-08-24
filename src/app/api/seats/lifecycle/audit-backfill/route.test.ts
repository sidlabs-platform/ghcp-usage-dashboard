import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const configState = vi.hoisted(() => ({
  getEnterpriseSlugs: vi.fn(),
}));

const repoState = vi.hoisted(() => ({
  resetSeatAuditCoverage: vi.fn(),
}));

vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));

vi.mock("@/lib/config/enterprise-config", () => ({
  getEnterpriseSlugs: () => configState.getEnterpriseSlugs(),
}));

vi.mock("@/lib/db/seat-lifecycle-repo", () => ({
  resetSeatAuditCoverage: (...args: unknown[]) => repoState.resetSeatAuditCoverage(...args),
}));

import { POST } from "./route";

const post = (url: string) => POST(new NextRequest(url, { method: "POST" }));

beforeEach(() => {
  configState.getEnterpriseSlugs.mockReturnValue(["ent-a", "ent-b"]);
  repoState.resetSeatAuditCoverage.mockReturnValue(2);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("seat audit backfill route", () => {
  it("clears audit coverage for every enterprise when none is specified", async () => {
    const res = await post("http://localhost/api/seats/lifecycle/audit-backfill");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, cleared: 2, enterprise: "all" });
    expect(repoState.resetSeatAuditCoverage).toHaveBeenCalledWith(undefined);
  });

  it("scopes the reset to a configured enterprise", async () => {
    const res = await post("http://localhost/api/seats/lifecycle/audit-backfill?enterprise=ent-b");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ enterprise: "ent-b" });
    expect(repoState.resetSeatAuditCoverage).toHaveBeenCalledWith("ent-b");
  });

  it("rejects an unknown enterprise instead of silently clearing nothing", async () => {
    const res = await post("http://localhost/api/seats/lifecycle/audit-backfill?enterprise=nope");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Unknown enterprise "nope". Configured enterprises: ent-a, ent-b',
    });
    expect(repoState.resetSeatAuditCoverage).not.toHaveBeenCalled();
  });

  it("treats a blank enterprise parameter as unscoped rather than invalid", async () => {
    const res = await post("http://localhost/api/seats/lifecycle/audit-backfill?enterprise=%20%20");
    expect(res.status).toBe(200);
    expect(repoState.resetSeatAuditCoverage).toHaveBeenCalledWith(undefined);
  });

  it("reports zero cleared without erroring when no audit sync state exists yet", async () => {
    repoState.resetSeatAuditCoverage.mockReturnValue(0);
    const res = await post("http://localhost/api/seats/lifecycle/audit-backfill");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, cleared: 0 });
  });

  it("does not leak the internal exception message on failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    repoState.resetSeatAuditCoverage.mockImplementation(() => {
      throw new Error("SQLITE_ERROR: no such column: copilot_seat_audit_sync_state.enterprise_slug");
    });
    const res = await post("http://localhost/api/seats/lifecycle/audit-backfill");
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to clear audit sync state." });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
