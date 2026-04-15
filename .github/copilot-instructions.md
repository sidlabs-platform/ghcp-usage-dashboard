# Copilot Instructions — GHCP Usage Dashboard

## Build & Run

```bash
npm run dev          # Dev server with Turbopack (http://localhost:3000)
npm run build        # Production build (Next.js)
npm run lint         # ESLint (next lint)
npx tsc --noEmit     # Type-check only (faster than full build, ~30s)
```

No test framework is configured. Validate changes with `npx tsc --noEmit` and `npm run build`.

## Architecture

Next.js 15 App Router dashboard that syncs GitHub Copilot enterprise metrics, GHAS alerts, and billing data into a local SQLite database, then serves pre-aggregated data through cached API routes.

### Data flow

```
GitHub APIs (Copilot metrics, seats, teams, GHAS, billing)
    ↓  sync-service fetches day-by-day, stores raw data
SQLite (data/copilot-metrics.db, WAL mode, better-sqlite3)
    ↓  refreshAllSummaries() populates pre-aggregated tables
Summary tables (user_period_summary, daily_aggregate_cache, team_summary_cache)
    ↓  API routes query summaries, not raw tables
API Routes (withCache → withTimeout wrappers)
    ↓  React Query fetches with scope/date filters
Dashboard pages (Recharts, dynamic imports, SSR disabled for charts)
```

### Key layers

| Layer | Location | Notes |
|-------|----------|-------|
| GitHub API clients | `src/lib/github/` | `api-base.ts` has shared fetch with adaptive rate limiting, retry, pagination |
| Sync orchestration | `src/lib/db/sync-service.ts` | `fullSync()`, `incrementalSync()`, `syncDay()` — lock via `sync_lock` table |
| Database | `src/lib/db/database.ts` | Singleton `getDb()`, schemas in `*.sql` files, auto-migrated on init |
| Repository layer | `src/lib/db/*-repo.ts` | `metrics-repo`, `seats-repo`, `teams-repo`, `ghas-repo`, `billing-repo` |
| Summary refresh | `src/lib/db/summary-tables.ts` | Called after sync; API routes read from these, not raw `user_daily_metrics` |
| Config | `src/lib/config/dashboard-config.ts` | Reads `dashboard-config.json` with 5-min cache, deep-merges with defaults |
| API middleware | `src/lib/api/` | `withCache()`, `withTimeout()`, `parseScopeFilter()`, pagination helpers |
| Cache | `src/lib/cache/memory-cache.ts` | In-memory TTL with LRU eviction (500 entries). Invalidated after sync |
| Contexts | `src/contexts/` | `DateRangeContext` (days), `ScopeContext` (team/org filtering) — shared across all pages |
| Export | `src/lib/export/` | CSV (paginated fetch-all), PDF (html2canvas + jspdf) |

### Auth

Uses `GITHUB_TOKEN` (PAT) from env. If a GitHub App is configured in env, use App auth for org-level endpoints and PAT only for enterprise-only endpoints. If no App is configured, PAT is used for everything.

## Conventions

### API route pattern

Every API GET handler follows this composition pattern:

```typescript
async function handler(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const days = Number(params.get("days") ?? 7);
  const { start, end } = getDateRange(days);
  // ... query logic using scope filter + pagination
  return NextResponse.json({ data, pagination });
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
```

- Wrap with `withCache` (TTL constants: `SHORT` 2m, `MEDIUM` 5m, `LONG` 10m, `FILTERS` 30m), then `withTimeout` (30s default)
- Parse scope with `parseScopeFilter(searchParams)` from `src/lib/api/scope-filter.ts`
- Paginated routes return `{ data, pagination: { page, pageSize, totalItems, totalPages } }`
- Use `buildOrderBy()` with an allowlist of column names to prevent SQL injection

### Dashboard page pattern

```typescript
"use client";

// Dynamic imports for charts (SSR disabled, ChartSkeleton loading state)
const MyChart = dynamic(
  () => import("@/components/charts/MyChart").then(m => ({ default: m.MyChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

export default function MyPage() {
  const { days } = useDateRange();
  const { buildScopeParams, hasFilter } = useScope();
  // Fetch from API with days + scope params, render cards + charts
}
```

- All dashboard pages are client components (`"use client"`)
- Charts are dynamically imported with `{ ssr: false }` and `ChartSkeleton` loading placeholder
- Use `useDateRange()` and `useScope()` from contexts for shared filter state
- Use `CHART_COLORS` from `src/lib/constants.ts` for consistent chart colors

### Database

- Schema files: `schema.sql`, `ghas-schema.sql`, `summary-schema.sql`, `billing-schema.sql` in `src/lib/db/`
- All schema files use `CREATE TABLE IF NOT EXISTS` — safe to re-run
- New columns added via migrations array in `database.ts` with `try/catch` for idempotency
- Repo layer (`*-repo.ts`) contains all SQL queries — no raw SQL in API routes
- After bulk inserts (sync), call `refreshAllSummaries()` then `cache.invalidateAll()`

### Config-driven feature flags

`dashboard-config.json` controls which features are synced and which sidebar pages are visible. Key behaviors:
- `copilot.enterprise: false` → skips enterprise API calls, force-disables billing
- `copilot.userMetrics: false` → hides pages that depend on per-user data (Code Gen, Features, Models, CLI, Teams, Users, IDE)
- Each GHAS category (`codeScanning`, `dependabot`, `secretScanning`) toggled independently
- Use `isMetricEnabled()`, `isCopilotSubEnabled()`, `getEffectiveBillingEnabled()` helpers — don't read config directly

### Styling

- Tailwind CSS v4 with CSS variables for theming: `hsl(var(--background))`, `hsl(var(--foreground))`, etc.
- Dark mode via `dark` class on `<html>`, persisted in localStorage
- `cn()` utility (clsx + tailwind-merge) for conditional class merging
- UI primitives in `src/components/ui/` (shadcn/ui pattern)

### Import aliases

`@/*` maps to `./src/*` (configured in `tsconfig.json`). Always use `@/` imports.

### GitHub API specifics

- GHAS alert endpoints (code scanning, dependabot, secret scanning) do not support `state=all` — omit the state param to get all alerts
- Billing endpoints use NDJSON format — use `fetchNDJSON()` from `api-base.ts`
- GitHub API version: `2026-03-10` (set in `api-base.ts`)
