// GitHub Copilot Membership Client — enterprise SCIM-provisioned users plus
// org membership, normalized into a stable account-state shape for the
// historical identity/seat ledger.
// API docs:
//  - https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/scim
//  - https://docs.github.com/en/rest/orgs/members
//
// Two sources are covered:
//  1. Enterprise SCIM `/scim/v2/enterprises/{enterprise}/Users` — the
//     authoritative source for Enterprise Managed Users (EMU) provisioning
//     state. `active: false` means the identity provider deactivated the
//     account; whether that reflects a temporary suspend or a full
//     deprovision is inferred from whether the SCIM record still carries a
//     linked GitHub account (see `deriveScimAccountState` below).
//  2. Org membership `GET /orgs/{org}/members` — a plain list of an org's
//     *current* members. Anyone returned by it is, by definition, an
//     active member; it carries no suspended/deprovisioned signal.
//
// In both cases, the normalized `observedLogin` is populated ONLY from a
// verified GitHub login field (SCIM's GitHub extension `githubUsername`,
// or the REST member's `login`) — never from SCIM's `userName`/`externalId`,
// which are identity-provider-controlled values (frequently an email
// address or IdP-internal id) that must never leak into a GitHub login
// field.

import { githubFetchWithMeta, githubFetchPaginated } from "./api-base";

// ── Raw SCIM shapes (partial) ────────────────────────────────────────────

const GITHUB_SCIM_EXTENSION = "urn:ietf:params:scim:schemas:extension:GitHub:2.0:User";

interface RawScimUser {
  id?: string;
  externalId?: string | null;
  userName?: string;
  active?: boolean;
  [GITHUB_SCIM_EXTENSION]?: { githubUsername?: string | null; githubUserId?: number | null } | null;
  [key: string]: unknown;
}

interface ScimUsersResponse {
  totalResults?: number;
  itemsPerPage?: number;
  startIndex?: number;
  Resources?: RawScimUser[];
}

/** Minimal org member shape returned by `GET /orgs/{org}/members`. */
export interface RawOrgMember {
  login: string;
  id: number;
}

// ── Normalized shape ─────────────────────────────────────────────────────

export type MembershipAccountState = "member" | "suspended" | "deprovisioned" | "unknown";
export type MembershipSource = "scim_enterprise" | "org_membership";

export interface NormalizedMembershipRecord {
  identityKey: string;
  githubUserId: number | null;
  /** A verified GitHub login only — never a SCIM userName/externalId. */
  observedLogin: string | null;
  /** SCIM externalId/userName. Always `null` for the org_membership source (REST carries no such concept). */
  externalIdentity: string | null;
  accountState: MembershipAccountState;
  source: MembershipSource;
  observedAt: string;
  raw: RawScimUser | RawOrgMember;
}

/**
 * Derive an account state from a raw SCIM resource. `active: false` always
 * means the identity provider deactivated the account (per GitHub's SCIM
 * docs: "should be suspended") — this client further distinguishes a
 * temporary suspend (the record still references a linked GitHub account)
 * from a full deprovision (the GitHub-account link has been severed, e.g.
 * after account deletion), since only the former can be safely reactivated
 * by flipping `active` back to `true`.
 */
function deriveScimAccountState(resource: RawScimUser): MembershipAccountState {
  if (typeof resource.active !== "boolean") return "unknown";
  if (resource.active) return "member";
  const linkedGithubLogin = resource[GITHUB_SCIM_EXTENSION]?.githubUsername;
  return linkedGithubLogin ? "suspended" : "deprovisioned";
}

function normalizeScimUser(resource: RawScimUser, now: string): NormalizedMembershipRecord {
  const githubExtension = resource[GITHUB_SCIM_EXTENSION];
  const login = githubExtension?.githubUsername || null;
  const githubUserId = typeof githubExtension?.githubUserId === "number" ? githubExtension.githubUserId : null;

  return {
    identityKey: resource.id ? `scim:${resource.id}` : `scim-external:${resource.externalId ?? "unknown"}`,
    githubUserId,
    observedLogin: login,
    externalIdentity: resource.externalId ?? resource.userName ?? null,
    accountState: deriveScimAccountState(resource),
    source: "scim_enterprise",
    observedAt: now,
    raw: resource,
  };
}

function normalizeOrgMember(member: RawOrgMember, now: string): NormalizedMembershipRecord {
  return {
    identityKey: `login:${member.login.toLowerCase()}`,
    githubUserId: typeof member.id === "number" ? member.id : null,
    observedLogin: member.login,
    // The org members list has no externalId/SCIM concept — always null,
    // never fabricated from the GitHub login itself.
    externalIdentity: null,
    accountState: "member",
    source: "org_membership",
    observedAt: now,
    raw: member,
  };
}

// ── SCIM pagination (startIndex/count/totalResults) ─────────────────────

export interface ScimFetchOptions {
  /** SCIM page size. Default 100. */
  count?: number;
  /** Safety cap on the number of pages fetched. Must be >= 1. Default 200. */
  maxPages?: number;
  enterpriseSlug?: string;
}

async function fetchEnterpriseScimUsers(
  enterprise: string,
  options: ScimFetchOptions = {},
): Promise<NormalizedMembershipRecord[]> {
  const { count = 100, maxPages = 200, enterpriseSlug } = options;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`copilotMembershipClient: maxPages must be an integer >= 1 (received ${maxPages}).`);
  }

  const now = new Date().toISOString();
  const records: NormalizedMembershipRecord[] = [];
  let startIndex = 1;

  for (let page = 0; page < maxPages; page++) {
    const path = `/scim/v2/enterprises/${encodeURIComponent(enterprise)}/Users?startIndex=${startIndex}&count=${count}`;
    const result = await githubFetchWithMeta<ScimUsersResponse>(path, { authMode: "pat", enterpriseSlug });
    const body = result.data;
    const resources = body?.Resources ?? [];
    if (resources.length === 0) break;

    for (const resource of resources) {
      records.push(normalizeScimUser(resource, now));
    }

    const totalResults = body?.totalResults ?? resources.length;
    startIndex += resources.length;
    if (startIndex > totalResults) break;
  }

  return records;
}

async function fetchOrgMembers(org: string, enterpriseSlug?: string): Promise<NormalizedMembershipRecord[]> {
  const now = new Date().toISOString();
  const members = await githubFetchPaginated<RawOrgMember>(`/orgs/${encodeURIComponent(org)}/members`, 100, undefined, enterpriseSlug);
  return members.map((member) => normalizeOrgMember(member, now));
}

// ── Exported client ───────────────────────────────────────────────────

export class CopilotMembershipClient {
  /** Enterprise-managed-user SCIM identities — member/suspended/deprovisioned/unknown account state. */
  async getEnterpriseScimUsers(enterprise: string, options: ScimFetchOptions = {}): Promise<NormalizedMembershipRecord[]> {
    return fetchEnterpriseScimUsers(enterprise, options);
  }

  /** Current org members. Every returned record's accountState is "member" — see module doc. */
  async getOrgMembers(org: string, enterpriseSlug?: string): Promise<NormalizedMembershipRecord[]> {
    return fetchOrgMembers(org, enterpriseSlug);
  }
}

export const copilotMembershipClient = new CopilotMembershipClient();
