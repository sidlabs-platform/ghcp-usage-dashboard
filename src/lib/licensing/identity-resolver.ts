// Deterministic identity resolution — resolves the canonical GitHub login,
// numeric GitHub user ID, external identity, and account state for a single
// license holder, following a strict, documented precedence chain rather
// than guessing. Pure/side-effect-free: no DB access, no network calls.
//
// Precedence (highest to lowest):
//   1. Live/source seat assignee real login.
//   2. Real audit-observed login for the same numeric GitHub user ID,
//      including recovery across periods (a later/earlier period's audit
//      trail may carry a real login even when the period under
//      resolution only observed an opaque/GUID-shaped value).
//   3. Enterprise SAML/SCIM external identity mapping (only when the
//      mapping explicitly supplies a verified GitHub login field).
//   4. Organization SAML identity mapping (same verified-login rule).
//   5. Configured identity-map import (same verified-login rule).
//   6. Stable internal "unresolved" holder identity — never fabricated.
//
// `userLogin`/`resolvedUserLogin` are strictly separated from
// `externalIdentity`: an external identity (SAML NameID, SCIM
// externalId/userName, email, or any other non-GitHub identifier) is NEVER
// promoted into a login field — only a mapping's explicit, verified
// `resolvedLogin` field can do that. This is a hard invariant, not a
// best-effort heuristic.

/** Canonical account states, ordered here from lowest to highest merge precedence. */
export type AccountState = "unknown" | "member" | "suspended" | "deprovisioned";

/** Which tier of the precedence chain ultimately determined this identity's resolution. */
export type IdentitySource = "seat" | "audit" | "enterprise_identity" | "org_identity" | "identity_map" | "unresolved";

/** Deterministically resolved identity for a single license holder. */
export interface ResolvedIdentity {
  /** Stable holder identity (numeric-id-based, login-based, or internal hash — see `seats-client.ts`'s `normalizeSeat`). Passed through unchanged. */
  holderKey: string;
  /** Numeric GitHub user ID, when known. Passed through unchanged — never re-derived or guessed. */
  githubUserId: number | null;
  /** Real GitHub login observed directly from a seat assignee or audit trail (tiers 1–2 only). Null when no direct observation resolved a real login. */
  userLogin: string | null;
  /** Final canonical GitHub login after the full precedence chain (tiers 1–5). Null only when fully unresolved. */
  resolvedUserLogin: string | null;
  /** Raw external identity value (SAML NameID, SCIM external ID/userName, legacy email, etc.) — informational only, never promoted to a login field. */
  externalIdentity: string | null;
  /** Which precedence tier produced `resolvedUserLogin` (or "unresolved" when none did). */
  source: IdentitySource;
  /** Merged account state across all available SCIM/membership evidence. */
  accountState: AccountState;
  /** Human-readable notes: obfuscated-login detections, collisions, recovery details, and the final unresolved reason. */
  notes: string[];
}

/** A single audit-observed login for a given occurrence, optionally tagged with the billing period it was observed in (enables cross-period recovery). */
export interface AuditLoginObservation {
  githubUserId?: number | null;
  observedLogin: string | null;
  occurredAt: string;
  period?: string | null;
}

/** External identity evidence from an enterprise/org SAML mapping, SCIM directory, or configured identity-map import. */
export interface ExternalIdentityEvidence {
  /** Raw external identity value (SAML NameID, SCIM externalId/userName, legacy email, etc.). Never used as a login. */
  externalIdentity?: string | null;
  /** A GitHub login the mapping *explicitly and verifiably* supplies. Only this field may ever populate `resolvedUserLogin`/`userLogin`. */
  resolvedLogin?: string | null;
  /** Account state as reported by this evidence source (e.g. SCIM `active`/`suspended`/`deprovisioned`). Case-insensitive; unrecognized values normalize to "unknown". */
  accountState?: string | null;
}

/** All evidence available for resolving a single holder's identity. */
export interface IdentityResolutionInput {
  holderKey: string;
  githubUserId?: number | null;
  /** Real-time/source seat assignee login, if any (tier 1). */
  seatLogin?: string | null;
  /** Audit-observed logins for this holder, across any number of periods (tier 2). */
  auditObservations?: AuditLoginObservation[];
  /** Enterprise-level SAML/SCIM identity evidence (tier 3). */
  enterpriseIdentity?: ExternalIdentityEvidence | null;
  /** Org-level SAML identity evidence (tier 4). */
  orgIdentity?: ExternalIdentityEvidence | null;
  /** Configured identity-map import evidence (tier 5). */
  identityMap?: ExternalIdentityEvidence | null;
}

// ── Real-login detection ─────────────────────────────────────────────────

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** GitHub logins are alphanumeric-or-hyphen, never starting/ending with a hyphen, and never containing consecutive hyphens. */
const GITHUB_LOGIN_SHAPE_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
const MAX_GITHUB_LOGIN_LENGTH = 39;

/**
 * True when `value` has the shape of a real GitHub login rather than an
 * opaque/obfuscated placeholder (a GUID, an email address, or a
 * SCIM/SAML-style identifier containing underscores or `@`, both of which
 * GitHub logins never contain). Used to decide whether a seat-assignee or
 * audit-observed login is trustworthy enough to resolve an identity, or
 * must be skipped in favor of a lower-precedence source.
 */
function looksLikeRealGitHubLogin(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_GITHUB_LOGIN_LENGTH) return false;
  if (GUID_RE.test(trimmed)) return false;
  if (trimmed.includes("@")) return false;
  if (trimmed.includes("_")) return false;
  return GITHUB_LOGIN_SHAPE_RE.test(trimmed);
}

/** Normalize a login for stable, case-insensitive joins (GitHub logins are case-insensitive). */
function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

// ── Account state normalization/merging ──────────────────────────────────

const ACCOUNT_STATE_PRECEDENCE: Record<AccountState, number> = {
  unknown: 0,
  member: 1,
  suspended: 2,
  deprovisioned: 3,
};

const ACCOUNT_STATE_ALIASES: Record<string, AccountState> = {
  active: "member",
  member: "member",
  enabled: "member",
  suspended: "suspended",
  disabled: "suspended",
  deprovisioned: "deprovisioned",
  deleted: "deprovisioned",
  removed: "deprovisioned",
};

/** Normalize an arbitrary, case-insensitive account-state string into a canonical {@link AccountState}, defaulting to "unknown" for unrecognized/missing values. */
function normalizeAccountState(value: string | null | undefined): AccountState {
  if (!value) return "unknown";
  const key = value.trim().toLowerCase();
  return ACCOUNT_STATE_ALIASES[key] ?? "unknown";
}

/** Merge multiple observed account states using deprovisioned > suspended > member > unknown precedence. */
function mergeAccountStates(states: AccountState[]): AccountState {
  let best: AccountState = "unknown";
  for (const state of states) {
    if (ACCOUNT_STATE_PRECEDENCE[state] > ACCOUNT_STATE_PRECEDENCE[best]) {
      best = state;
    }
  }
  return best;
}

// ── Audit-observation recovery (tier 2) ──────────────────────────────────

interface NormalizedObservation {
  normalizedLogin: string;
  occurredAt: string;
  occurredAtMs: number;
  period: string | null;
}

/**
 * Deterministically pick the winning real login among possibly-conflicting
 * audit observations for the same numeric GitHub user ID: most recent
 * `occurredAt` wins; ties break alphabetically on the normalized login
 * itself, never on input array order.
 */
function pickAuditWinner(observations: NormalizedObservation[]): NormalizedObservation {
  return [...observations].sort((a, b) => {
    if (a.occurredAtMs !== b.occurredAtMs) return b.occurredAtMs - a.occurredAtMs;
    return a.normalizedLogin.localeCompare(b.normalizedLogin);
  })[0];
}

// ── Main resolution ───────────────────────────────────────────────────────

/**
 * Resolve a single holder's canonical identity from all available evidence,
 * following the documented precedence chain. Never throws for missing
 * evidence — an unresolvable holder degrades to a typed `"unresolved"`
 * result carrying an explanatory note, never a fabricated login.
 */
export function resolveIdentity(input: IdentityResolutionInput): ResolvedIdentity {
  const githubUserId = input.githubUserId ?? null;
  const notes: string[] = [];

  let userLogin: string | null = null;
  let resolvedUserLogin: string | null = null;
  let source: IdentitySource = "unresolved";

  // Tier 1: live/source seat assignee real login.
  const seatCandidate = input.seatLogin?.trim() || null;
  if (seatCandidate) {
    if (looksLikeRealGitHubLogin(seatCandidate)) {
      userLogin = normalizeLogin(seatCandidate);
      resolvedUserLogin = userLogin;
      source = "seat";
    } else {
      notes.push(
        `Seat-assignee login "${seatCandidate}" looks like an opaque/GUID-shaped value, not a real GitHub login — ignored for resolution.`,
      );
    }
  }

  // Tier 2: real audit-observed login for the same numeric GitHub user ID,
  // including recovery across periods.
  if (!resolvedUserLogin) {
    const candidates = (input.auditObservations ?? []).filter(
      (obs) => githubUserId == null || obs.githubUserId == null || obs.githubUserId === githubUserId,
    );
    const obfuscatedSeen = candidates.some((obs) => obs.observedLogin != null && !looksLikeRealGitHubLogin(obs.observedLogin));

    const realObservations: NormalizedObservation[] = [];
    for (const obs of candidates) {
      if (!looksLikeRealGitHubLogin(obs.observedLogin)) continue;
      const ms = Date.parse(obs.occurredAt);
      if (Number.isNaN(ms)) {
        throw new Error(`Invalid audit observation occurredAt: "${obs.occurredAt}"`);
      }
      realObservations.push({
        normalizedLogin: normalizeLogin(obs.observedLogin as string),
        occurredAt: obs.occurredAt,
        occurredAtMs: ms,
        period: obs.period ?? null,
      });
    }

    if (realObservations.length > 0) {
      const distinctLogins = new Set(realObservations.map((o) => o.normalizedLogin));
      const winner = pickAuditWinner(realObservations);
      userLogin = winner.normalizedLogin;
      resolvedUserLogin = winner.normalizedLogin;
      source = "audit";

      if (distinctLogins.size > 1) {
        notes.push(
          `Collision: multiple distinct real logins observed in the audit trail for github user ${githubUserId ?? "unknown"} (${[...distinctLogins].sort().join(", ")}); deterministically selected "${winner.normalizedLogin}" (most recent observation${winner.period ? ` from period ${winner.period}` : ""}).`,
        );
      } else if (obfuscatedSeen) {
        notes.push(
          `Recovered real login "${winner.normalizedLogin}" for github user ${githubUserId ?? "unknown"} from audit history${winner.period ? ` (period ${winner.period})` : ""}, after an opaque/GUID-shaped login was observed elsewhere.`,
        );
      } else {
        notes.push(
          `Resolved login "${winner.normalizedLogin}" from audit observation history${winner.period ? ` (period ${winner.period})` : ""}.`,
        );
      }
    }
  }

  // Tier 3: enterprise SAML/SCIM identity mapping (verified login field only).
  if (!resolvedUserLogin && input.enterpriseIdentity?.resolvedLogin) {
    resolvedUserLogin = normalizeLogin(input.enterpriseIdentity.resolvedLogin);
    source = "enterprise_identity";
    notes.push(`Resolved login "${resolvedUserLogin}" from enterprise SAML/SCIM identity mapping (verified GitHub login field).`);
  }

  // Tier 4: organization SAML identity mapping (verified login field only).
  if (!resolvedUserLogin && input.orgIdentity?.resolvedLogin) {
    resolvedUserLogin = normalizeLogin(input.orgIdentity.resolvedLogin);
    source = "org_identity";
    notes.push(`Resolved login "${resolvedUserLogin}" from organization SAML identity mapping (verified GitHub login field).`);
  }

  // Tier 5: configured identity-map import (verified login field only).
  if (!resolvedUserLogin && input.identityMap?.resolvedLogin) {
    resolvedUserLogin = normalizeLogin(input.identityMap.resolvedLogin);
    source = "identity_map";
    notes.push(`Resolved login "${resolvedUserLogin}" from configured identity-map import (verified GitHub login field).`);
  }

  // Tier 6: stable internal unresolved holder identity.
  if (!resolvedUserLogin) {
    source = "unresolved";
    notes.push(`No real GitHub login could be resolved for holder "${input.holderKey}" from any source — retaining the stable internal holder key.`);
  }

  // externalIdentity is independent of login resolution: it's the most
  // authoritative external identity value available (enterprise > org >
  // configured map), kept purely for audit/traceability. It is never used
  // to populate userLogin/resolvedUserLogin.
  const externalIdentity =
    input.enterpriseIdentity?.externalIdentity?.trim() ||
    input.orgIdentity?.externalIdentity?.trim() ||
    input.identityMap?.externalIdentity?.trim() ||
    null;

  const accountState = mergeAccountStates([
    normalizeAccountState(input.enterpriseIdentity?.accountState),
    normalizeAccountState(input.orgIdentity?.accountState),
    normalizeAccountState(input.identityMap?.accountState),
  ]);

  return {
    holderKey: input.holderKey,
    githubUserId,
    userLogin,
    resolvedUserLogin,
    externalIdentity,
    source,
    accountState,
    notes,
  };
}
