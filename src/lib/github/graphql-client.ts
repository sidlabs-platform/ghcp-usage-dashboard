// GitHub GraphQL API client — thin wrapper over the shared authenticated
// fetch primitive that adds typed variables, cursor pagination, null-node
// skipping, partial-data/error preservation, and rate-limit integration.
// API docs: https://docs.github.com/en/graphql
//
// Query-only, by design: this client retries automatically (default 3
// attempts with jittered backoff), which is only safe for idempotent
// operations. All current and planned callers in this codebase issue
// read-only GraphQL queries, so `githubGraphQL`/`githubGraphQLPaginated`
// validate that the operation is not a mutation (or subscription) and
// reject immediately if it is — retrying a non-idempotent mutation could
// duplicate side effects. If a mutation is ever genuinely required, add an
// explicit, separate low-level helper that hardcodes `retries: 1` rather
// than relaxing this check.

import { githubFetchWithMeta, type AuthMode } from "./api-base";

// ── Types ──────────────────────────────────────────────────────────────

/** A single error entry returned alongside (possibly partial) GraphQL data. */
export interface GraphQLError {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

interface GraphQLHttpResponse<T> {
  data?: T | null;
  errors?: GraphQLError[];
}

export interface GraphQLRequestOptions {
  /** Typed GraphQL variables sent alongside the query. */
  variables?: Record<string, unknown>;
  /** Max retry attempts for the underlying HTTP request. Defaults to 3. */
  retries?: number;
  /** Enterprise slug to scope PAT/App auth selection to. */
  enterpriseSlug?: string;
  /**
   * Force enterprise PAT auth context for this request, bypassing the normal
   * App-vs-PAT resolution. Required for enterprise-identity callers that
   * must guarantee PAT credentials are used (e.g. enterprise audit/billing
   * GraphQL fields that are not exposed to GitHub App installation tokens).
   */
  forceEnterprisePAT?: boolean;
}

/** Result of a single GraphQL request — data may be partial. */
export interface GraphQLResult<T> {
  data: T | null;
  /** Sanitized, human-readable warnings derived from any GraphQL `errors`. */
  warnings: string[];
}

// ── Sanitization ───────────────────────────────────────────────────────

// Redact anything that looks like a GitHub credential so error messages
// echoed back from the API (which may quote request fragments) can never
// leak one. Covers:
//  - classic tokens/PATs: ghp_, gho_, ghu_, ghs_, ghr_
//  - fine-grained PATs: github_pat_...
//  - raw Bearer-scheme values in an Authorization header/message
const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /\bbearer\s+[A-Za-z0-9._-]{10,}/gi,
];

function sanitizeMessage(message: string): string {
  let sanitized = message;
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized.replace(/\n|\r/g, " ");
}

function warningsFromErrors(errors: GraphQLError[] | undefined): string[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((err) => {
    const location = err.path && err.path.length > 0 ? ` (at ${err.path.join(".")})` : "";
    return `${sanitizeMessage(err.message)}${location}`;
  });
}

// ── Query-only validation ───────────────────────────────────────────────

/**
 * Reject anything that isn't a query. Detects an explicit leading
 * `mutation`/`subscription` operation keyword (GraphQL's shorthand query
 * syntax — a bare `{ ... }` or an explicit leading `query` keyword — is
 * always allowed). This is a best-effort, practical guard: it does not
 * parse the full GraphQL document, but it does catch the overwhelmingly
 * common way a mutation would be written.
 */
function assertIsReadOnlyQuery(operation: string): void {
  const match = /^\s*(mutation|subscription)\b/i.exec(operation);
  if (match) {
    const kind = match[1].toLowerCase();
    throw new Error(
      `githubGraphQL only supports read-only queries — refusing to execute a "${kind}" operation. ` +
      "Automatic retries are not safe for non-idempotent operations; this client intentionally has no mutation support.",
    );
  }
}

// ── Single request ─────────────────────────────────────────────────────

/**
 * Execute a single, read-only GraphQL query against /graphql. Mutations and
 * subscriptions are rejected — see the query-only note at the top of this
 * file. Returns whatever data GitHub provided (even if partial) plus
 * sanitized warnings derived from any `errors` entries — callers get
 * partial data instead of a hard failure, matching GraphQL's error model.
 */
export async function githubGraphQL<T>(
  query: string,
  options: GraphQLRequestOptions = {},
): Promise<GraphQLResult<T>> {
  assertIsReadOnlyQuery(query);
  const { variables, retries = 3, enterpriseSlug, forceEnterprisePAT } = options;
  const authMode: AuthMode | undefined = forceEnterprisePAT ? "pat" : undefined;

  const result = await githubFetchWithMeta<GraphQLHttpResponse<T>>("/graphql", {
    method: "POST",
    body: { query, variables },
    retries,
    authMode,
    enterpriseSlug,
  });

  const warnings = warningsFromErrors(result.data?.errors);
  const data = result.data?.data ?? null;

  return { data, warnings };
}

// ── Cursor pagination ────────────────────────────────────────────────

/** A GraphQL Relay-style connection: nodes (which may include nulls) + pageInfo. */
export interface GraphQLConnection<TNode> {
  /** May be absent or null entirely on some partial-error responses. */
  nodes?: (TNode | null | undefined)[] | null;
  /** May be absent or null entirely on some partial-error responses. */
  pageInfo?: {
    hasNextPage: boolean;
    endCursor: string | null;
  } | null;
}

export interface GraphQLPaginationOptions extends GraphQLRequestOptions {
  /** Safety cap on the number of pages fetched. Defaults to 50. Must be >= 1. */
  maxPages?: number;
}

export interface GraphQLPaginatedResult<TNode> {
  nodes: TNode[];
  warnings: string[];
}

/**
 * Page through a GraphQL connection using the `after` cursor convention.
 * The caller's query must accept an `$after: String` variable and expose a
 * `pageInfo { hasNextPage endCursor }` selection reachable via
 * `extractConnection`. Null/missing nodes, a null/missing `pageInfo`, and an
 * `extractConnection` that throws because an intermediate/parent field came
 * back null (e.g. reading `data.organization.members` when `organization`
 * itself is null on a partial-error response) are all tolerated — pagination
 * stops gracefully and a sanitized warning is recorded — rather than
 * throwing. Partial per-page errors are preserved as warnings (pagination
 * continues), and iteration is bounded by `maxPages` (which must be >= 1) to
 * guard against a misbehaving or looping API — if the guard trips while the
 * API still reports more pages available, a warning is added so callers
 * know the result set is incomplete.
 */
export async function githubGraphQLPaginated<TNode, TData>(
  query: string,
  extractConnection: (data: TData) => GraphQLConnection<TNode> | null | undefined,
  options: GraphQLPaginationOptions = {},
): Promise<GraphQLPaginatedResult<TNode>> {
  const { maxPages = 50, variables, ...rest } = options;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`githubGraphQLPaginated: maxPages must be an integer >= 1 (received ${maxPages}).`);
  }

  const nodes: TNode[] = [];
  const warnings: string[] = [];
  let after: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const result = await githubGraphQL<TData>(query, {
      ...rest,
      variables: { ...(variables ?? {}), after },
    });
    warnings.push(...result.warnings);

    if (!result.data) break;

    let connection: GraphQLConnection<TNode> | null | undefined;
    try {
      connection = extractConnection(result.data);
    } catch (err) {
      // A parent/intermediate field (e.g. `organization`) came back null on
      // a partial-error response, so reading through to the connection
      // threw. Treat this the same as "no connection" rather than crashing
      // the whole pagination — but record why, sanitized.
      const reason = err instanceof Error ? sanitizeMessage(err.message) : "unknown error";
      warnings.push(`Could not read pagination results from the response (a parent field was likely null): ${reason}`);
      break;
    }
    if (!connection) break;

    for (const node of connection.nodes ?? []) {
      if (node !== null && node !== undefined) nodes.push(node);
    }

    const pageInfo = connection.pageInfo;
    const hasNextPage = !!pageInfo?.hasNextPage;
    const endCursor = pageInfo?.endCursor ?? null;

    if (!hasNextPage || !endCursor) break;

    if (page === maxPages - 1) {
      // More pages are available, but we've hit the safety cap — surface
      // that so callers don't mistake a truncated result for a complete one.
      warnings.push(
        `Pagination truncated after reaching the ${maxPages}-page limit while more results were still available.`,
      );
      break;
    }

    after = endCursor;
  }

  return { nodes, warnings };
}
