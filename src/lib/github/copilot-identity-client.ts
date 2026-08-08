// GitHub Copilot Identity Client — enterprise/org external identity
// resolution via GraphQL (SAML/SCIM `externalIdentities`).
// API docs: https://docs.github.com/en/graphql/reference/objects#externalidentity
//
// Login renames and cross-org identity drift are reconciled by resolving
// each GitHub user against their SAML/SCIM external identity. Enterprise
// identities are authoritative and preferred; a per-org identity fallback
// is used only when the caller opts in (some enterprises only have
// org-level SAML SSO configured, not enterprise-managed users).
//
// This client is built entirely on the existing query-only GraphQL client
// (`githubGraphQL`/`githubGraphQLPaginated`) — it never issues a mutation
// and inherits that client's automatic retry-safety and partial-error
// tolerance (null intermediate nodes, per-page GraphQL `errors`) rather
// than reimplementing any of it.

import { githubGraphQLPaginated, type GraphQLConnection } from "./graphql-client";

// ── Raw GraphQL shapes (partial — only fields this client reads) ───────

interface RawExternalIdentityNode {
  guid?: string | null;
  samlIdentity?: { nameId?: string | null; username?: string | null } | null;
  scimIdentity?: { username?: string | null } | null;
  user?: { login?: string | null; databaseId?: number | null } | null;
}

interface EnterpriseIdentitiesQueryData {
  enterprise?: {
    ownerInfo?: {
      samlIdentityProvider?: {
        externalIdentities?: GraphQLConnection<RawExternalIdentityNode> | null;
      } | null;
    } | null;
  } | null;
}

interface OrgIdentitiesQueryData {
  organization?: {
    samlIdentityProvider?: {
      externalIdentities?: GraphQLConnection<RawExternalIdentityNode> | null;
    } | null;
  } | null;
}

// ── Normalized identity record ───────────────────────────────────────────

export type CopilotIdentitySource = "enterprise_identity" | "org_identity";

export interface NormalizedIdentityRecord {
  /** Stable per-identity key: the SAML/SCIM `guid` when present, else a login-based fallback. */
  identityKey: string;
  githubUserId: number | null;
  resolvedLogin: string | null;
  /** SAML `nameId` (preferred) or SCIM `username`, whichever the identity provider populated. */
  externalIdentity: string | null;
  source: CopilotIdentitySource;
  /** ISO 8601 timestamp — when this client observed the identity (not GitHub-provided). */
  observedAt: string;
  raw: RawExternalIdentityNode;
}

export interface IdentityFetchResult {
  identities: NormalizedIdentityRecord[];
  /** Sanitized warnings surfaced from partial GraphQL errors or null intermediate nodes. */
  warnings: string[];
}

function normalizeIdentity(node: RawExternalIdentityNode, source: CopilotIdentitySource, now: string): NormalizedIdentityRecord {
  const externalIdentity = node.samlIdentity?.nameId ?? node.scimIdentity?.username ?? node.samlIdentity?.username ?? null;
  const login = node.user?.login ?? null;
  const identityKey = node.guid ? `guid:${node.guid}` : login ? `login:${login.toLowerCase()}` : `external:${externalIdentity ?? "unknown"}`;

  return {
    identityKey,
    githubUserId: typeof node.user?.databaseId === "number" ? node.user.databaseId : null,
    resolvedLogin: login,
    externalIdentity,
    source,
    observedAt: now,
    raw: node,
  };
}

const ENTERPRISE_IDENTITIES_QUERY = `
  query($slug: String!, $after: String) {
    enterprise(slug: $slug) {
      ownerInfo {
        samlIdentityProvider {
          externalIdentities(first: 100, after: $after) {
            nodes {
              guid
              samlIdentity { nameId username }
              scimIdentity { username }
              user { login databaseId }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

const ORG_IDENTITIES_QUERY = `
  query($org: String!, $after: String) {
    organization(login: $org) {
      samlIdentityProvider {
        externalIdentities(first: 100, after: $after) {
          nodes {
            guid
            samlIdentity { nameId username }
            scimIdentity { username }
            user { login databaseId }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export interface IdentityFetchOptions {
  /** Safety cap on the number of GraphQL pages fetched. Default 50 (see `githubGraphQLPaginated`). */
  maxPages?: number;
  enterpriseSlug?: string;
}

export class CopilotIdentityClient {
  /**
   * Enterprise-level SAML/SCIM external identities — the preferred,
   * authoritative source. Enterprise identity queries require PAT auth
   * (not exposed to GitHub App installation tokens), so this always forces
   * enterprise PAT auth context.
   */
  async getEnterpriseIdentities(enterprise: string, options: IdentityFetchOptions = {}): Promise<IdentityFetchResult> {
    const now = new Date().toISOString();
    const { nodes, warnings } = await githubGraphQLPaginated<RawExternalIdentityNode, EnterpriseIdentitiesQueryData>(
      ENTERPRISE_IDENTITIES_QUERY,
      (data) => data.enterprise?.ownerInfo?.samlIdentityProvider?.externalIdentities,
      {
        variables: { slug: enterprise },
        maxPages: options.maxPages,
        enterpriseSlug: options.enterpriseSlug,
        forceEnterprisePAT: true,
      },
    );

    return {
      identities: nodes.map((node) => normalizeIdentity(node, "enterprise_identity", now)),
      warnings,
    };
  }

  /**
   * Org-level SAML external identities. Only meaningful as an optional
   * fallback for enterprises without enterprise-managed users / a
   * consolidated identity provider — callers decide when to use this,
   * this client does not infer that on its own.
   */
  async getOrgIdentities(org: string, options: IdentityFetchOptions = {}): Promise<IdentityFetchResult> {
    const now = new Date().toISOString();
    const { nodes, warnings } = await githubGraphQLPaginated<RawExternalIdentityNode, OrgIdentitiesQueryData>(
      ORG_IDENTITIES_QUERY,
      (data) => data.organization?.samlIdentityProvider?.externalIdentities,
      {
        variables: { org },
        maxPages: options.maxPages,
        enterpriseSlug: options.enterpriseSlug,
      },
    );

    return {
      identities: nodes.map((node) => normalizeIdentity(node, "org_identity", now)),
      warnings,
    };
  }

  /**
   * Resolve identities preferring the enterprise source, optionally
   * layering in org-level identities as a fallback (e.g. for orgs whose
   * users aren't represented in the enterprise identity provider). Org
   * identities are only merged in for orgs not already covered by a
   * resolved enterprise identity with the same login, so an enterprise
   * record is never shadowed by a less-authoritative org one.
   */
  async resolveIdentities(
    enterprise: string,
    orgFallbacks: string[],
    options: IdentityFetchOptions = {},
  ): Promise<IdentityFetchResult> {
    const enterpriseResult = await this.getEnterpriseIdentities(enterprise, options);
    const warnings = [...enterpriseResult.warnings];

    if (orgFallbacks.length === 0) {
      return { identities: enterpriseResult.identities, warnings };
    }

    const resolvedLogins = new Set(
      enterpriseResult.identities.map((i) => i.resolvedLogin?.toLowerCase()).filter((login): login is string => !!login),
    );

    const identities = [...enterpriseResult.identities];
    for (const org of orgFallbacks) {
      const orgResult = await this.getOrgIdentities(org, options);
      warnings.push(...orgResult.warnings);
      for (const identity of orgResult.identities) {
        const loginKey = identity.resolvedLogin?.toLowerCase();
        if (loginKey && resolvedLogins.has(loginKey)) continue;
        identities.push(identity);
        if (loginKey) resolvedLogins.add(loginKey);
      }
    }

    return { identities, warnings };
  }
}

export const copilotIdentityClient = new CopilotIdentityClient();
