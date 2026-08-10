import { describe, it, expect } from "vitest";
import { resolveIdentity, type IdentityResolutionInput } from "./identity-resolver";

describe("resolveIdentity — precedence", () => {
  it("prefers a real seat-assignee login over every other source", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:1",
      githubUserId: 1,
      seatLogin: "octocat",
      auditObservations: [{ githubUserId: 1, observedLogin: "old-login", occurredAt: "2026-01-01T00:00:00Z" }],
      enterpriseIdentity: { resolvedLogin: "enterprise-login", externalIdentity: "saml-nameid-1" },
      orgIdentity: { resolvedLogin: "org-login" },
      identityMap: { resolvedLogin: "mapped-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("seat");
    expect(result.userLogin).toBe("octocat");
    expect(result.resolvedUserLogin).toBe("octocat");
    expect(result.holderKey).toBe("id:1");
    expect(result.githubUserId).toBe(1);
  });

  it("falls back to a real audit-observed login when no seat login is available", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:2",
      githubUserId: 2,
      seatLogin: null,
      auditObservations: [{ githubUserId: 2, observedLogin: "audit-user", occurredAt: "2026-02-01T00:00:00Z" }],
      enterpriseIdentity: { resolvedLogin: "enterprise-login" },
      orgIdentity: { resolvedLogin: "org-login" },
      identityMap: { resolvedLogin: "mapped-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("audit");
    expect(result.userLogin).toBe("audit-user");
    expect(result.resolvedUserLogin).toBe("audit-user");
  });

  it("falls back to enterprise SAML/SCIM identity mapping when no seat/audit login is available", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:3",
      githubUserId: 3,
      enterpriseIdentity: { resolvedLogin: "enterprise-login", externalIdentity: "saml-nameid-3" },
      orgIdentity: { resolvedLogin: "org-login" },
      identityMap: { resolvedLogin: "mapped-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("enterprise_identity");
    expect(result.resolvedUserLogin).toBe("enterprise-login");
    // userLogin is only ever populated from direct seat/audit observation.
    expect(result.userLogin).toBeNull();
    expect(result.externalIdentity).toBe("saml-nameid-3");
  });

  it("falls back to org SAML identity mapping when no seat/audit/enterprise login is available", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:4",
      githubUserId: 4,
      orgIdentity: { resolvedLogin: "org-login" },
      identityMap: { resolvedLogin: "mapped-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("org_identity");
    expect(result.resolvedUserLogin).toBe("org-login");
    expect(result.userLogin).toBeNull();
  });

  it("falls back to the configured identity-map import as the last resolvable tier", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:5",
      githubUserId: 5,
      identityMap: { resolvedLogin: "mapped-login", externalIdentity: "legacy-id-5" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("identity_map");
    expect(result.resolvedUserLogin).toBe("mapped-login");
    expect(result.externalIdentity).toBe("legacy-id-5");
  });

  it("resolves to a stable unresolved holder identity when nothing can be resolved", () => {
    const input: IdentityResolutionInput = { holderKey: "internal:abc123", githubUserId: null };
    const result = resolveIdentity(input);
    expect(result.source).toBe("unresolved");
    expect(result.resolvedUserLogin).toBeNull();
    expect(result.userLogin).toBeNull();
    expect(result.holderKey).toBe("internal:abc123");
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe("resolveIdentity — GUID/opaque login detection", () => {
  it("does not treat a GUID-shaped seat login as a real GitHub login", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:6",
      githubUserId: 6,
      seatLogin: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      identityMap: { resolvedLogin: "real-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("identity_map");
    expect(result.resolvedUserLogin).toBe("real-login");
    expect(result.userLogin).toBeNull();
    expect(result.notes.some((n) => n.toLowerCase().includes("guid") || n.toLowerCase().includes("opaque"))).toBe(true);
  });

  it("does not treat an email-shaped or underscore-containing audit login as a real GitHub login", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:7",
      githubUserId: 7,
      auditObservations: [
        { githubUserId: 7, observedLogin: "someone@example.com", occurredAt: "2026-01-01T00:00:00Z" },
        { githubUserId: 7, observedLogin: "scim_user_7", occurredAt: "2026-01-02T00:00:00Z" },
      ],
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("unresolved");
    expect(result.resolvedUserLogin).toBeNull();
  });

  it("rejects invalid enterprise and org mapped logins before falling back to a valid configured mapping", () => {
    const invalidEnterpriseLogin = "enterprise_identity@example.com";
    const invalidOrgLogin = "org_identity_with_underscores";
    const result = resolveIdentity({
      holderKey: "id:mapped-validation",
      githubUserId: 70,
      enterpriseIdentity: { resolvedLogin: invalidEnterpriseLogin },
      orgIdentity: { resolvedLogin: invalidOrgLogin },
      identityMap: { resolvedLogin: "valid-mapped-login" },
    });

    expect(result.source).toBe("identity_map");
    expect(result.resolvedUserLogin).toBe("valid-mapped-login");
    expect(result.notes.some((note) => /ignored/i.test(note))).toBe(true);
    expect(result.notes.join("\n")).not.toContain(invalidEnterpriseLogin);
    expect(result.notes.join("\n")).not.toContain(invalidOrgLogin);
  });

  it("rejects invalid mapped logins at every mapped-identity tier without leaking them into notes", () => {
    const invalidLogins = [
      "enterprise_identity@example.com",
      "org_identity_with_underscores",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    ];
    const result = resolveIdentity({
      holderKey: "id:invalid-mapped-logins",
      githubUserId: 71,
      enterpriseIdentity: { resolvedLogin: invalidLogins[0] },
      orgIdentity: { resolvedLogin: invalidLogins[1] },
      identityMap: { resolvedLogin: invalidLogins[2] },
    });

    expect(result.source).toBe("unresolved");
    expect(result.resolvedUserLogin).toBeNull();
    for (const invalidLogin of invalidLogins) {
      expect(result.notes.join("\n")).not.toContain(invalidLogin);
    }
  });
});

describe("resolveIdentity — hardened opaque-login detection (Task 6 spec-review)", () => {
  it("does not treat a dashed GUID as a real GitHub login (regression baseline)", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:guid-dashed",
      githubUserId: 100,
      seatLogin: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      identityMap: { resolvedLogin: "real-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("identity_map");
    expect(result.userLogin).toBeNull();
  });

  it("does not treat a compact (dashless) 32-character hex GUID as a real GitHub login", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:guid-compact",
      githubUserId: 101,
      seatLogin: "3fa85f6457174562b3fc2c963f66afa6", // 32 hex chars, no dashes
      identityMap: { resolvedLogin: "real-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("identity_map");
    expect(result.resolvedUserLogin).toBe("real-login");
    expect(result.userLogin).toBeNull();
    expect(result.notes.some((n) => n.toLowerCase().includes("guid") || n.toLowerCase().includes("opaque"))).toBe(true);
  });

  it("does not treat a longer hex/hash-like identifier (36 chars) as a real GitHub login", () => {
    const hexBlob = "0123456789abcdef0123456789abcdef1234";
    expect(hexBlob.length).toBe(36);
    const input: IdentityResolutionInput = {
      holderKey: "id:hexblob-36",
      githubUserId: 102,
      seatLogin: hexBlob,
      identityMap: { resolvedLogin: "real-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("identity_map");
    expect(result.userLogin).toBeNull();
  });

  it("does not treat a 39-character all-hex identifier (at the max login length) as a real GitHub login", () => {
    const hexBlob = "0123456789abcdef0123456789abcdef0123456"; // 39 hex chars
    expect(hexBlob.length).toBe(39);
    const input: IdentityResolutionInput = {
      holderKey: "id:hexblob-39",
      githubUserId: 103,
      seatLogin: hexBlob,
      identityMap: { resolvedLogin: "real-login" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("identity_map");
    expect(result.userLogin).toBeNull();
  });

  it("still accepts a legitimate short hex-looking login well under hash-blob length", () => {
    const input: IdentityResolutionInput = { holderKey: "id:short-hex", githubUserId: 104, seatLogin: "deadbeef" };
    const result = resolveIdentity(input);
    expect(result.source).toBe("seat");
    expect(result.userLogin).toBe("deadbeef");
  });

  it("still accepts a legitimate alphanumeric login at the 39-character max GitHub login length", () => {
    const login = "z".repeat(39);
    expect(login.length).toBe(39);
    const input: IdentityResolutionInput = { holderKey: "id:max-len", githubUserId: 105, seatLogin: login };
    const result = resolveIdentity(input);
    expect(result.source).toBe("seat");
    expect(result.userLogin).toBe(login);
  });

  it("still accepts a legitimate dashed login shape at the 39-character max GitHub login length", () => {
    const login = "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t";
    expect(login.length).toBe(39);
    const input: IdentityResolutionInput = { holderKey: "id:max-len-dashed", githubUserId: 106, seatLogin: login };
    const result = resolveIdentity(input);
    expect(result.source).toBe("seat");
    expect(result.userLogin).toBe(login);
  });
});

describe("resolveIdentity — numeric GitHub ID recovery across periods", () => {
  it("recovers a real login observed in a different period for the same numeric GitHub user ID", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:8",
      githubUserId: 8,
      auditObservations: [
        { githubUserId: 8, observedLogin: "3fa85f64-5717-4562-b3fc-2c963f66afa6", occurredAt: "2026-03-01T00:00:00Z", period: "2026-03" },
        { githubUserId: 8, observedLogin: "real-user-8", occurredAt: "2026-01-01T00:00:00Z", period: "2026-01" },
      ],
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("audit");
    expect(result.resolvedUserLogin).toBe("real-user-8");
    expect(result.notes.some((n) => n.includes("2026-01"))).toBe(true);
  });

  it("ignores audit observations for a different numeric GitHub user ID", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:9",
      githubUserId: 9,
      auditObservations: [{ githubUserId: 999, observedLogin: "someone-elses-login", occurredAt: "2026-01-01T00:00:00Z" }],
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("unresolved");
    expect(result.resolvedUserLogin).toBeNull();
  });
});

describe("resolveIdentity — collisions", () => {
  it("deterministically resolves conflicting real logins observed for the same numeric GitHub user ID via the most recent observation, with a note", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:10",
      githubUserId: 10,
      auditObservations: [
        { githubUserId: 10, observedLogin: "login-a", occurredAt: "2026-01-01T00:00:00Z", period: "2026-01" },
        { githubUserId: 10, observedLogin: "login-b", occurredAt: "2026-02-01T00:00:00Z", period: "2026-02" },
      ],
    };
    const first = resolveIdentity(input);
    const second = resolveIdentity(input);
    expect(first.resolvedUserLogin).toBe("login-b"); // most recent wins
    expect(first).toEqual(second); // deterministic — repeated calls agree
    expect(first.notes.some((n) => n.toLowerCase().includes("collision"))).toBe(true);
  });

  it("breaks a same-timestamp collision deterministically (alphabetical) rather than guessing", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:11",
      githubUserId: 11,
      auditObservations: [
        { githubUserId: 11, observedLogin: "zeta-login", occurredAt: "2026-01-01T00:00:00Z" },
        { githubUserId: 11, observedLogin: "alpha-login", occurredAt: "2026-01-01T00:00:00Z" },
      ],
    };
    const result = resolveIdentity(input);
    expect(result.resolvedUserLogin).toBe("alpha-login");
  });
});

describe("resolveIdentity — account state merging", () => {
  it("prefers deprovisioned over suspended/member/unknown across evidence sources", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:12",
      githubUserId: 12,
      identityMap: { resolvedLogin: "some-login" },
      enterpriseIdentity: { accountState: "suspended" },
      orgIdentity: { accountState: "deprovisioned" },
    };
    const result = resolveIdentity(input);
    expect(result.accountState).toBe("deprovisioned");
  });

  it("prefers suspended over member/unknown when no deprovisioned evidence exists", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:13",
      githubUserId: 13,
      seatLogin: "active-user",
      enterpriseIdentity: { accountState: "member" },
      orgIdentity: { accountState: "suspended" },
    };
    const result = resolveIdentity(input);
    expect(result.accountState).toBe("suspended");
  });

  it("defaults to unknown when no account-state evidence is present", () => {
    const input: IdentityResolutionInput = { holderKey: "id:14", githubUserId: 14, seatLogin: "some-user" };
    const result = resolveIdentity(input);
    expect(result.accountState).toBe("unknown");
  });

  it("normalizes case-insensitive account state values from SCIM/membership evidence", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:15",
      githubUserId: 15,
      identityMap: { resolvedLogin: "some-login" },
      enterpriseIdentity: { accountState: "DEPROVISIONED" },
    };
    const result = resolveIdentity(input);
    expect(result.accountState).toBe("deprovisioned");
  });
});

describe("resolveIdentity — external identity invariant", () => {
  it("never places external identity, SAML nameId, SCIM values, or email into userLogin/resolvedUserLogin", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:16",
      githubUserId: 16,
      enterpriseIdentity: { externalIdentity: "CN=jdoe,OU=Users,DC=example,DC=com" },
      orgIdentity: { externalIdentity: "scim-external-id-16" },
      identityMap: { externalIdentity: "legacy-email@example.com" },
    };
    const result = resolveIdentity(input);
    expect(result.userLogin).toBeNull();
    expect(result.resolvedUserLogin).toBeNull();
    expect(result.source).toBe("unresolved");
    // The external identity is still preserved, just never promoted to a login field.
    expect(result.externalIdentity).toBe("CN=jdoe,OU=Users,DC=example,DC=com");
  });

  it("keeps externalIdentity populated even when a real login is resolved via a higher-precedence source", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:17",
      githubUserId: 17,
      seatLogin: "octocat17",
      enterpriseIdentity: { externalIdentity: "saml-nameid-17" },
    };
    const result = resolveIdentity(input);
    expect(result.source).toBe("seat");
    expect(result.resolvedUserLogin).toBe("octocat17");
    expect(result.externalIdentity).toBe("saml-nameid-17");
  });

  it("only promotes a mapping's resolvedLogin field to resolvedUserLogin, never externalIdentity", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:18",
      githubUserId: 18,
      identityMap: { externalIdentity: "opaque-external-18", resolvedLogin: undefined },
    };
    const result = resolveIdentity(input);
    expect(result.resolvedUserLogin).toBeNull();
    expect(result.source).toBe("unresolved");
  });
});

describe("resolveIdentity — case normalization", () => {
  it("normalizes resolved login casing consistently", () => {
    const input: IdentityResolutionInput = { holderKey: "id:19", githubUserId: 19, seatLogin: "OctoCat" };
    const result = resolveIdentity(input);
    expect(result.userLogin).toBe("octocat");
    expect(result.resolvedUserLogin).toBe("octocat");
  });

  it("is stable/idempotent across repeated calls with identical input", () => {
    const input: IdentityResolutionInput = {
      holderKey: "id:20",
      githubUserId: 20,
      seatLogin: "SomeUser",
      enterpriseIdentity: { accountState: "Suspended" },
    };
    expect(resolveIdentity(input)).toEqual(resolveIdentity({ ...input }));
  });
});
