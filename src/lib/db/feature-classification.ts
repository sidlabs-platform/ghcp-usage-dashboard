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
// `chat_inline`, `copilot_cli` and any unrecognized/unknown feature name are
// intentionally EXCLUDED — they must never be silently folded into IDE
// completion metrics. `copilot_cli` has its own bucket (IS_CLI_SQL) and its own
// place in the acceptance rate (IS_ACCEPTANCE_ELIGIBLE_SQL) below.
export const IS_COMPLETION_SQL = `(${FEATURE_SQL} IN ('code_completion', 'inline_chat', 'chat_panel') OR ${FEATURE_SQL} LIKE 'chat\\_panel\\_%' ESCAPE '\\')`;

export const IS_AGENT_SQL = `${FEATURE_SQL} = 'agent_edit'`;

// The standalone Copilot App surface — distinct from completion and agent_edit.
export const IS_COPILOT_APP_SQL = `${FEATURE_SQL} = 'copilot_app'`;

// The Copilot CLI surface. It is its own bucket, deliberately in none of the
// three above, because it is genuinely a fourth kind of surface:
//
//   - Unlike `agent_edit`, the CLI reports real `code_generation_activity_count`
//     AND `code_acceptance_activity_count`, so its acceptances are a true
//     accept/reject signal and belong in the acceptance rate.
//   - Unlike IDE completion, it writes to files directly, so its `loc_added_sum`
//     dwarfs its `loc_suggested_to_add_sum` and must NOT be pooled with
//     IDE completion LoC (doing so makes "accepted vs suggested" nonsense).
//
// Before this bucket existed `copilot_cli` matched no predicate at all: it fell
// out of the acceptance rate entirely (discarding ~76% of real acceptances and
// making a fleet accepting ~77% of suggestions read as ~12%) while still being
// counted by NOT_AGENT_OR_APP_SQL on the language surfaces, so two pages
// disagreed by two orders of magnitude about the same month.
export const IS_CLI_SQL = `${FEATURE_SQL} = 'copilot_cli'`;

// Surfaces whose accept/reject counts are meaningful, and therefore the correct
// basis for an acceptance rate: IDE completion plus the CLI.
//
// `agent_edit` is excluded because it reports `code_acceptance_activity_count`
// as a hard 0 while still reporting generations, so including it can only
// deflate the rate. `copilot_app` is excluded for the same reason it is
// excluded from completion metrics — it is reported separately.
export const IS_ACCEPTANCE_ELIGIBLE_SQL = `(${IS_COMPLETION_SQL} OR ${IS_CLI_SQL})`;

// Rows to exclude from "completion" language/LOC surfaces. Uses exclusion
// (rather than the IS_COMPLETION_SQL allowlist) so language rows without a
// `feature` key (older synced data) remain backward compatible.
export const NOT_AGENT_OR_APP_SQL = `COALESCE(${FEATURE_SQL}, '') NOT IN ('agent_edit', 'copilot_app')`;
