# GitHub Copilot Instructions — GHCP Usage Dashboard

## Project Context
This is a Next.js 15 (App Router) TypeScript dashboard for GitHub Copilot enterprise usage metrics. It uses SQLite via Node's built-in **`node:sqlite`** module (`DatabaseSync`), Recharts for charts, and TailwindCSS for styling.

> **`node:sqlite` — not better-sqlite3.** The package is built into Node 26+; there is nothing to install and no native rebuild step. Key differences from better-sqlite3:
> - Read-only connections: `new DatabaseSync(path, { readOnly: true })`
> - The API is a strict subset — `.pluck()`, user-defined functions, and other better-sqlite3 helpers do **not** exist
> - Do not generate or suggest code that imports or installs `better-sqlite3`
>
> **DB path is hardcoded** (`src/lib/db/database.ts:9`): `path.join(process.cwd(), "data", "copilot-metrics.db")` with no environment override. Pointing a dev server or test run at an alternate database requires copying the file into place. An env-var override (`DB_PATH`/`DATA_DIR`) is tracked in issue #91.

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
- Compares "Chat & completions" adopters (phases 0+1) against "Agent-first" adopters (phases 2+3) on cost/dev/month, % payroll/month, and PRs/dev/month
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
- Token columns returned again as of the 2026-08-11 changelog, under **new names**: `input`, `output`, `cache_read`, `cache_write` (summed by `date` + `model` + `username`). Parsed into `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. Legacy `input_tokens`/`output_tokens`/`cached_tokens` header names are still accepted as fallbacks, and `cached_tokens` is kept mirrored from `cache_read` so pre-existing queries/exports are unchanged
- The live report also carries a `repository` column. It is part of the storage dedup key (`idx_billing_premium_dedup_v2`) — omitting it silently collapsed ~23% of live `octodemo` rows. `aggregatePremiumRecords()` pre-sums any records that still share the full key, so the write path is loss-proof
- `aic_quantity` / `aic_gross_amount` can arrive as a literal `"0"` (not blank) while `quantity` carries the real credits. For `unit_type === "ai-credits"`, fall back whenever the parsed aic value is `<= 0`, not only when the cell is empty
- `exceeds_quota` is only present in `premium_request` reports, not `ai_credit`
- Config uses both `premiumRequests` and `aiCredits` toggles under `billing` — page shows if EITHER is enabled
- The dashboard URL path stays `/dashboard/billing-premium` but the UI label is "AI Credits"
- Use `aic_quantity` / `aic_gross_amount` for the primary credit-based display; legacy `quantity` / `gross_amount` still available for request-based metrics

### Token Usage Analytics
- Source: the per-model token breakdown GitHub added to the AI usage report on 2026-08-11 (`input`, `output`, `cache_read`, `cache_write`). No new API surface — the `ai_credit` report was already synced.
- Storage: `billing_premium_requests.input_tokens / output_tokens / cache_read_tokens / cache_write_tokens`, plus `repository`. All added by additive `ALTER TABLE ... ADD COLUMN ... DEFAULT 0` migrations in `database.ts`, which run **before** the schema file is executed (this ordering is load-bearing).
- **Pool vs. additional split.** The `ai_credit` report has no `exceeds_quota`, so the split is derived from amounts. Canonical expression is `POOL_FRACTION_SQL` in `billing-repo.ts`: `exceeds_quota='TRUE'` -> 0.0; `'FALSE'` -> 1.0; else `MIN(1, MAX(0, discount_amount/gross_amount))`; `gross_amount = 0` -> 1.0 (fully pool). Never inline this rule — always reuse the shared fragment.
- **Credits and USD are different units.** `discount_amount`/`net_amount` are USD and split directly; credits are apportioned by the discount/gross *ratio*. Never sum them together.
- Queries live at the end of `billing-repo.ts`: `getTokenKpis`, `getTokenModelSummary`, `getTokenDailyTrend`, `getTokenUserSummary`, `getTokenAttribution`, `getTokenModelDailySeries`, `getTokenUserModelEfficiency`, `getTokenExportRows`. All aggregate in SQL via `buildTokenQuery()`; only the correlation/anomaly math runs in JS, over already-aggregated rows.
- Analysis module: `src/lib/analysis/token-credits.ts` — Pearson correlation, non-negative least squares (NNLS) for implied per-token credit rates, cache-savings estimation, and MAD-based anomaly detection. NNLS is used because credit rates cannot be negative and the four token kinds are highly collinear; it returns `null` when the fit is unidentifiable.
- **Anomaly detection uses `robustScale()`, not raw MAD.** MAD is exactly 0 whenever more than half the sample shares a value — the common case here (a fleet of similar-rate models plus one runaway) — which would silently suppress the very outliers the feature exists to find. `robustScale()` prefers MAD and falls back to *mean* absolute deviation, which is zero only when every value is identical.
- **Fitted rates are estimates, not published pricing** — always label them as such in the UI. Cache savings report `null` (rendered "—") when the fit does not price cache reads below fresh input, rather than a misleading `0`.
- Page: `/dashboard/token-usage` (`visKey: "tokenUsage"`, gated identically to `billingPremium`). API: `/api/billing/tokens`, `/api/billing/tokens/backfill`, `/api/export/tokens`.
- **Graceful degradation is mandatory**: rows synced before this feature carry zero tokens. `/api/billing/tokens` returns `hasTokenData: false` with zeroed KPIs and empty arrays — never a 500 — and the page shows an explicit empty state with an opt-in backfill button. The backfill deletes only `billing_sync_state` rows for `ai_credit`/`premium_request`, never usage data.
