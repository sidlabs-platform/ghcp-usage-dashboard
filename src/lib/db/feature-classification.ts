// Pure SQL feature-classification predicates — the single source of truth for
// "is this feature a completion feature" (and its agent/Copilot App/legacy
// counterparts) across the whole codebase. This module has NO imports (in
// particular, no import of "./database" or "./aggregation-queries") so it can
// be imported directly by both aggregation-queries.ts and the startup summary
// cache migration (summary-cache-migration.ts) without creating a circular
// import: database.ts -> summary-cache-migration.ts -> aggregation-queries.ts
// -> database.ts would otherwise be a cycle.
//
// Never rely on a bare `!= 'agent_edit'` exclusion for "completion" — that
// would silently misclassify any new/unknown feature (e.g. `copilot_app`,
// `chat_inline`) as a completion feature. Every call site (aggregation-queries.ts,
// summary-tables.ts, summary-cache-migration.ts, src/app/api/users/[login]/route.ts,
// src/app/api/teams/[slug]/route.ts) reuses these exact fragments instead of
// re-declaring/copying them — one definition of "completion" for the whole codebase.

export const FEATURE_SQL = "json_extract(j.value, '$.feature')";

// Mirrors isCompletionFeature() in src/lib/aggregation/separate-metrics.ts:
// code_completion, inline_chat, chat_panel, and chat_panel_* user-level modes.
// `chat_inline` and any unrecognized/unknown feature name are intentionally
// EXCLUDED — they must never be silently folded into completion metrics.
export const IS_COMPLETION_SQL = `(${FEATURE_SQL} IN ('code_completion', 'inline_chat', 'chat_panel') OR ${FEATURE_SQL} LIKE 'chat\\_panel\\_%' ESCAPE '\\')`;

export const IS_AGENT_SQL = `${FEATURE_SQL} = 'agent_edit'`;

// The standalone Copilot App surface — distinct from completion and agent_edit.
export const IS_COPILOT_APP_SQL = `${FEATURE_SQL} = 'copilot_app'`;

// Rows to exclude from "completion" language/LOC surfaces. Uses exclusion
// (rather than the IS_COMPLETION_SQL allowlist) so language rows without a
// `feature` key (older synced data) remain backward compatible.
export const NOT_AGENT_OR_APP_SQL = `COALESCE(${FEATURE_SQL}, '') NOT IN ('agent_edit', 'copilot_app')`;
