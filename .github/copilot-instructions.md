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
