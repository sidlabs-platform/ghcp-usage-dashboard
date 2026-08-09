import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const preflightState = vi.hoisted(() => ({
  preflightEnterpriseAuth: vi.fn(),
}));

const enterpriseConfigState = vi.hoisted(() => ({
  getEnterpriseSlugs: vi.fn(),
}));

vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));

vi.mock("@/lib/config/enterprise-config", () => ({
  getEnterpriseSlugs: (...a: unknown[]) => enterpriseConfigState.getEnterpriseSlugs(...a),
}));

const GitHubApiErrorCtor = vi.hoisted(() => {
  class GitHubApiError extends Error {
    status: number;
    retryable: boolean;
    constructor(status: number, message: string, retryable = false) {
      super(message);
      this.name = "GitHubApiError";
      this.status = status;
      this.retryable = retryable;
    }
  }
  return GitHubApiError;
});

vi.mock("@/lib/github/auth-preflight", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/auth-preflight")>(
    "@/lib/github/auth-preflight",
  );
  return {
    ...actual,
    preflightEnterpriseAuth: (...a: unknown[]) => preflightState.preflightEnterpriseAuth(...a),
  };
});

vi.mock("@/lib/github/api-base", () => ({
  GitHubApiError: GitHubApiErrorCtor,
  githubFetchWithMeta: vi.fn(),
}));

import { GET } from "./route";

function req(url: string): NextRequest {
  return new NextRequest(url);
}

const BASE_URL = "http://localhost/api/billing/license-reconciliation/preflight";

beforeEach(() => {
  enterpriseConfigState.getEnterpriseSlugs.mockReturnValue(["acme", "other-ent"]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("license reconciliation preflight route", () => {
  it("returns 400 when enterprise is missing", async () => {
    const res = await GET(req(BASE_URL));
    expect(res.status).toBe(400);
  });

  it("returns 400 when enterprise is unknown", async () => {
    const res = await GET(req(`${BASE_URL}?enterprise=unknown-ent`));
    expect(res.status).toBe(400);
  });

  it("returns typed capabilities and overall ok status on success (supported)", async () => {
    preflightState.preflightEnterpriseAuth.mockResolvedValue({
      enterpriseSlug: "acme",
      capabilities: [
        { capability: "copilot_seats", label: "Copilot seat assignments", status: "supported", required: true, message: "Copilot seat assignments: access confirmed." },
      ],
      ok: true,
    });
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.enterpriseSlug).toBe("acme");
    expect(body.capabilities[0].status).toBe("supported");
  });

  it("returns unsupported capabilities and ok:false when the auth check reports missing scopes", async () => {
    preflightState.preflightEnterpriseAuth.mockResolvedValue({
      enterpriseSlug: "acme",
      capabilities: [
        { capability: "copilot_seats", label: "Copilot seat assignments", status: "unsupported", required: true, message: "Copilot seat assignments: required access is missing. Grant an appropriate scope or permission." },
      ],
      ok: false,
    });
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.capabilities[0].status).toBe("unsupported");
  });

  it("synthesizes every capability as unknown (never unsupported) when the identity check is rate-limited", async () => {
    preflightState.preflightEnterpriseAuth.mockRejectedValue(
      new GitHubApiErrorCtor(403, "API rate limit exceeded", true),
    );
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    for (const cap of body.capabilities) {
      expect(cap.status).toBe("unknown");
    }
  });

  it("synthesizes every capability as unsupported when the identity check fails with a non-retryable 401/403, without echoing the raw error message", async () => {
    preflightState.preflightEnterpriseAuth.mockRejectedValue(
      new GitHubApiErrorCtor(401, "Bad credentials: token=SUPER_SECRET_TOKEN_VALUE"),
    );
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    for (const cap of body.capabilities) {
      expect(cap.status).toBe("unsupported");
    }
    expect(JSON.stringify(body)).not.toContain("SUPER_SECRET_TOKEN_VALUE");
  });

  it("returns 500 for a genuinely unexpected (non-GitHubApiError) failure", async () => {
    preflightState.preflightEnterpriseAuth.mockRejectedValue(new Error("boom"));
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("boom");
  });

  it("sets a private, no-store cache header", async () => {
    preflightState.preflightEnterpriseAuth.mockResolvedValue({ enterpriseSlug: "acme", capabilities: [], ok: true });
    const res = await GET(req(`${BASE_URL}?enterprise=acme`));
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(res.headers.get("Cache-Control")).toMatch(/private/);
  });
});
