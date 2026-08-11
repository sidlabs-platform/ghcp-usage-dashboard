# GitHub Copilot Instructions — GHCP Usage Dashboard

## Project Context
This is a Next.js 15 (App Router) TypeScript dashboard for GitHub Copilot enterprise usage metrics. It uses SQLite via better-sqlite3, Recharts for charts, and TailwindCSS for styling.

## Architecture Rules

### Database Layer (`src/lib/db/`)
- All database access through `getDb()` singleton
- Schema files: `schema.sql`, `summary-schema.sql`, `ghas-schema.sql`, `billing-schema.sql`
- **Always push aggregation into SQL** — never load all rows into JS just to aggregate
- Use `json_each()` SQLite function to aggregate JSON array columns directly in SQL
- Parameterize all queries — never interpolate user input into SQL strings
- Use `buildLoginFilter()` and `buildEnterpriseFilter()` helpers for dynamic WHERE clauses
- Wrap bulk operations in transactions for performance

### API Routes (`src/app/api/`)
- Parse scope filters with `parseScopeFilter(searchParams)`
- Apply user filtering with `filterByScope()` or SQL-level `allowedLogins`
- Support query params: `days`, `teams`, `orgs`, `enterprises`
- Wrap with `withTimeout()` (30s) and `withCache()` for resilience
- Return appropriate `Cache-Control` headers
- Return 400 for invalid inputs with descriptive error messages

### Summary Tables (`src/lib/db/summary-tables.ts`)
- Pre-aggregate data during sync to avoid runtime computation
- Tables: `daily_aggregate_cache`, `user_period_summary`, `team_summary_cache`
- `refreshAllSummaries()` called after sync completes
- New summary tables should follow the same refresh pattern

### Type Safety
- All metric types defined in `src/lib/types/metrics.ts`
- Use interfaces for object shapes, named exports
- Strict TypeScript — no `any` types

### Performance Guidelines
- **Critical**: `getAllUserMetrics()` loads all rows + parses 6 JSON columns per row — causes OOM on large datasets
- Prefer SQL aggregation via `aggregation-queries.ts` over JS-side loops
- Use `json_each()` for totals_by_model_feature, totals_by_language_feature, totals_by_feature breakdown
- Add row-count guards: return 400 if estimated rows exceed threshold
- Cache expensive computations in summary tables refreshed during sync

### Testing
- Use Vitest; test files co-located as `*.test.ts`
- Run: `npm test`, `npm run test:coverage`

### Backward Compatibility (Hard Rule)
- **Never introduce changes that require a full data re-sync or re-fetch** — all schema changes, new tables, and new columns must work with existing local data
- New features must degrade gracefully when underlying data is missing (e.g., a new detail page shows "No data available" instead of crashing)
- Schema migrations must use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` with defaults — never drop and recreate tables that hold synced data
- New API routes must return valid empty responses (empty arrays, zero counts) when queried data does not yet exist — never 500 on missing data
- The dashboard must remain fully usable immediately after a code update without any manual intervention (no re-sync, no DB reset, no env changes)

### Code Conventions
- Follow existing naming: `getChatModeSums`, `getAdoptionStats`, `refreshDailyAggregate`
- JSDoc on exported functions
- Use `COALESCE(SUM(...), 0)` for nullable SQL aggregations
- Sort results consistently (by day ASC, by count DESC)

### LOC Metric Semantics (Critical)
Understanding GitHub Copilot API metric definitions is essential. These come from the **current Copilot Usage Metrics API** (NDJSON reports), not the legacy metrics API.

#### Top-Level LOC Fields (per user-day or per org-day)
- `loc_suggested_to_add_sum` — Lines Copilot **suggested** adding. Sums across all features, but `agent_edit` **always contributes 0** because agent writes directly to files without showing suggestions.
- `loc_added_sum` — Lines **actually added** to the editor. Includes completion accepted + chat applies + **agent_edit file writes**. This is a superset — it can exceed `loc_suggested_to_add_sum` when agents are active.
- `loc_suggested_to_delete_sum` — Lines suggested for deletion (future support, currently always 0).
- `loc_deleted_sum` — Lines deleted from the editor (primarily from agent_edit).

#### Why `loc_added_sum` Can Exceed `loc_suggested_to_add_sum`
The `agent_edit` feature writes code directly to files without showing suggestions. In `totals_by_feature`:
```json
{ "feature": "agent_edit", "loc_suggested_to_add_sum": 0, "loc_added_sum": 2342 }
```
When aggregated at the top level, agent writes inflate `loc_added_sum` while `loc_suggested_to_add_sum` stays unaffected. **This is expected GitHub API behavior, not a data error.**

#### Acceptance Rate
- Formula: `code_acceptance_activity_count / code_generation_activity_count × 100`
- This is an **event-count ratio**, NOT a LOC ratio.
- `agent_edit` has `code_acceptance_activity_count = 0` always, but may have non-zero `code_generation_activity_count` — which deflates the top-level acceptance rate.
- **Always compute acceptance rate from completion features only** (code_completion, inline_chat, chat_panel*) to avoid deflation from agent activity.

#### Feature Classification Rules
Use `isCompletionFeature()` and `isAgentFeature()` from `src/lib/aggregation/separate-metrics.ts`:
- **Completion features**: `code_completion`, `inline_chat`, `chat_panel`, and all `chat_panel_*` modes (user-level data uses mode-specific names like `chat_panel_ask_mode`, `chat_panel_edit_mode`, etc.)
- **Agent features**: `agent_edit`
- **Important**: At org/enterprise level, the feature name is `chat_panel` (aggregate). At user level, it's broken into `chat_panel_ask_mode`, `chat_panel_edit_mode`, etc. Code must handle both.

#### Rules for Displaying LOC Metrics
- **Never display raw top-level `loc_added_sum` as "LoC Accepted"** — it includes agent writes
- Use `json_each(totals_by_feature)` or `separate-metrics.ts` helpers to compute **completion-only** LOC
- Show "Agent LoC" separately from completion metrics
- When filtering `totals_by_language_feature`, exclude `agent_edit` rows to avoid inflating per-language totals

### AI Adoption Cohorts
- The API classifies each engaged user into an **AI adoption phase** based on rolling 28-day Copilot usage
- **Phase 0** (No cohort): Did not meet engagement criteria
- **Phase 1** (Code first): Code completion and/or IDE agent mode on ≥2 days
- **Phase 2** (Agent first): Single GitHub-based agent surface (cloud agent, code review, CLI) on ≥2 days
- **Phase 3** (Multi-agent): Two+ GitHub agent surfaces or GitHub Copilot app on ≥2 days
- User-level: `ai_adoption_phase` field (object with `phase`, `label`, `version`)
- Enterprise/org-level: `totals_by_ai_adoption_phase` array with per-phase engagement averages
- Per-phase **total PRs merged** (`total_pull_requests_merged`, June 2026 API addition): absolute delivery throughput per cohort, enterprise/org reports only. Optional field — degrade gracefully (`hasMergeData` flag, "—" / hidden section) when older synced data lacks it. User-level reports have no per-phase PR data.
- Stored as JSON TEXT columns: `ai_adoption_phase` on `user_daily_metrics`, `totals_by_ai_adoption_phase` on `enterprise_daily_metrics`/`org_daily_metrics`
- Dashboard page: `/dashboard/adoption-cohorts` — distribution chart, trend chart, per-phase metrics table, a "Delivery Impact by Phase" section (merged-PR KPIs, merged-by-phase bar chart, merged trend), and a "Potential ROI" section
- API: `/api/metrics/adoption-cohorts` — uses enterprise data when available, falls back to user-level aggregation; returns `mergedDistribution`, `mergedTrend`, `totalMerged`, `hasMergeData`
- Cohort user counts span the **entire** requested window (distinct users active on any day), not just the window's final day. The response carries `countBasis: "window" | "snapshot"`; `"snapshot"` means per-user phase data was unavailable and the enterprise last-day figure was used instead.

### Potential ROI
- Compares early adopters (phases 0+1) against agent-first adopters (phases 2+3) on cost/dev/month, % payroll/month, and PRs/dev/month
- API: `/api/metrics/roi` — see `GROUP_DEFINITIONS` in `src/app/api/metrics/roi/route.ts`; SQL helpers live at the end of `src/lib/db/metrics-repo.ts`
- Cost precedence: billing `aic_gross_amount` (per user, joined on `LOWER(username) = LOWER(user_login)`) → `ai_credits_used × creditToUsd` → `costSource: "none"` so the UI renders "—" instead of `$0.00`
- `metrics.billing.licensing` is server-only and deliberately stripped from `/api/config` — read `creditToUsd` inside the route via `getLicensingConfig()` and return only derived USD; never widen the client config payload
- **Two different monthly divisors**: cost is summed over the requested `days` → `× DAYS_PER_MONTH / days`. But `total_pull_requests_merged` is already a 28-day rolling aggregate, so it uses `× DAYS_PER_MONTH / ENTERPRISE_ROLLING_WINDOW_DAYS` and is read from the **latest** enterprise day row only (summing across days would multiply-count the same PRs)
- `hasPrData` is forced false when more than one enterprise is in scope — a single enterprise row cannot describe a multi-enterprise scope
- Salary is applied client-side (`src/lib/roi/salary.ts`) so the selector recalculates without a refetch; persisted in `localStorage` under `ghcp:roi:annualSalary`
- No schema changes and no re-sync required

### Billing: AI Credits (replacing Premium Requests)
- As of June 2026, GitHub Copilot uses **AI Credits** instead of Premium Requests
- The `ai_credit` billing report type is a superset of `premium_request` — it contains both legacy `copilot_premium_request` rows (unit_type: `requests`) and new `copilot_ai_credit` rows (unit_type: `ai-credits`)
- New columns: `aic_quantity` (AI Credit equivalent), `aic_gross_amount` (AI Credit cost), `cost_center_name`
- Removed columns: `input_tokens`, `output_tokens`, `cached_tokens` — no longer returned by the API; kept in schema with defaults for backward compat
- `exceeds_quota` is only present in `premium_request` reports, not `ai_credit`
- Config uses both `premiumRequests` and `aiCredits` toggles under `billing` — page shows if EITHER is enabled
- The dashboard URL path stays `/dashboard/billing-premium` but the UI label is "AI Credits"
- Use `aic_quantity` / `aic_gross_amount` for the primary credit-based display; legacy `quantity` / `gross_amount` still available for request-based metrics
