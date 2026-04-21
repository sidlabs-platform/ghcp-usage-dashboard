# Claude AI Coding Instructions — GHCP Usage Dashboard

## Project Overview
Next.js 15 (App Router, TypeScript) dashboard for GitHub Copilot usage metrics. Uses SQLite (better-sqlite3) for storage, Recharts for visualization, TailwindCSS for styling, and Vitest for testing.

## Architecture
- **API Routes**: `src/app/api/` — Next.js route handlers returning JSON
- **Database Layer**: `src/lib/db/` — SQLite schema, repos, aggregation queries, summary tables
- **Aggregation**: `src/lib/aggregation/` — JS-side metric separation (completion vs agent)
- **Frontend**: `src/app/dashboard/` pages + `src/components/` charts/cards
- **Types**: `src/lib/types/metrics.ts` — shared TypeScript interfaces

## Key Patterns

### Database
- All DB access via `getDb()` singleton from `database.ts`
- Schema defined in `schema.sql`, `summary-schema.sql`, `ghas-schema.sql`, `billing-schema.sql`
- Pre-aggregated summary tables populated by `summary-tables.ts` after sync
- JSON columns (`totals_by_feature`, `totals_by_model_feature`, etc.) store stringified arrays
- Use SQLite `json_each()` for in-DB JSON aggregation when possible

### API Routes
- Use `parseScopeFilter()` + `filterByScope()` for team/org/enterprise filtering
- Support `days`, `teams`, `orgs`, `enterprises` query params
- `allowedLogins` restricts user-level data by team/org membership
- Wrap handlers with `withTimeout()` and `withCache()` for resilience
- Return `Cache-Control` headers for client-side caching

### SQL Conventions
- Always parameterize queries (no string interpolation for values)
- Use `buildLoginFilter()` / `buildEnterpriseFilter()` for dynamic WHERE clauses
- Prefer `COALESCE(SUM(...), 0)` for nullable aggregations
- Use `INSERT OR REPLACE` for upserts on primary key

### Performance
- **Prefer SQL aggregation** over loading all rows into JS memory
- Use `json_each()` to aggregate JSON array columns in SQL
- Add row-count guards for large result sets
- Summary tables (`daily_aggregate_cache`, `user_period_summary`) reduce repeated computation
- Batch operations in transactions

### Testing
- Vitest with `@vitest/coverage-v8`
- Test files co-located: `*.test.ts` next to source
- Run: `npm test`, `npm run test:coverage`

## Code Style
- TypeScript strict mode
- Named exports preferred
- Interfaces over type aliases for object shapes
- Descriptive function names following existing patterns (`getChatModeSums`, `getAdoptionStats`)
- JSDoc comments on exported functions

## Common Pitfalls
- `getAllUserMetrics()` loads ALL user-day records + parses 6 JSON columns — avoid for large date ranges
- `totals_by_feature` is a JSON array stored as TEXT; must parse or use `json_each()`
- Enterprise filtering uses `enterprise_slug` (TEXT), not `enterprise_id`
- `filterByScope()` filters in JS after loading — prefer SQL-level filtering
