// GitHub GraphQL API client — thin wrapper over the shared authenticated
// fetch primitive that adds typed variables, cursor pagination, null-node
// skipping, partial-data/error preservation, and rate-limit integration.
// API docs: https://docs.github.com/en/graphql

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
  /** Typed GraphQL variables sent alongside the query/mutation. */
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

// ── Single request ─────────────────────────────────────────────────────

/**
 * Execute a single GraphQL query/mutation against /graphql.
 * Returns whatever data GitHub provided (even if partial) plus sanitized
 * warnings derived from any `errors` entries — callers get partial data
 * instead of a hard failure, matching GraphQL's error model.
 */
export async function githubGraphQL<T>(
  query: string,
  options: GraphQLRequestOptions = {},
): Promise<GraphQLResult<T>> {
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
  /** Safety cap on the number of pages fetched. Defaults to 50. */
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
 * `extractConnection`. Null/missing nodes and a null/missing `pageInfo` are
 * tolerated (treated as "no more items"/"no next page" respectively) rather
 * than throwing, partial per-page errors are preserved as warnings
 * (pagination continues), and iteration is bounded by `maxPages` to guard
 * against a misbehaving or looping API — if the guard trips while the API
 * still reports more pages available, a warning is added so callers know
 * the result set is incomplete.
 */
export async function githubGraphQLPaginated<TNode, TData>(
  query: string,
  extractConnection: (data: TData) => GraphQLConnection<TNode> | null | undefined,
  options: GraphQLPaginationOptions = {},
): Promise<GraphQLPaginatedResult<TNode>> {
  const { maxPages = 50, variables, ...rest } = options;
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

    const connection = extractConnection(result.data);
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
