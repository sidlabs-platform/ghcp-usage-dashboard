# Program: test-coverage

## Goal

Increase test coverage by writing new unit tests for untested modules.

## Strategy

1. **Target pure utility modules first** — functions with no external dependencies (DB, network)
2. **Then target modules with mockable dependencies** — cache, timeout wrappers
3. **Avoid** testing React components or Next.js route handlers (complex setup, low ROI per line)
4. **Avoid** testing modules that require a real SQLite database unless mocking is straightforward

## Priority Order (highest impact first)

1. `src/lib/cache/memory-cache.ts` — pure class, no deps
2. `src/lib/api/timeout.ts` — simple wrapper
3. `src/lib/api/pagination.ts` — pure parsing logic
4. `src/lib/api/scope-filter.ts` — has DB dep but parsing is testable
5. `src/lib/config/` — configuration parsing
6. `src/lib/github/` — API clients (mock fetch)
7. `src/lib/db/` — database layer (requires SQLite mock)
8. `src/lib/sync/` — orchestration (complex mocking)

## Conventions

- Test files co-located: `foo.test.ts` next to `foo.ts`
- Import from `vitest`: `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`
- Use `vi.useFakeTimers()` for time-dependent tests
- Use `vi.fn()` / `vi.mock()` for dependency isolation
- Group tests with `describe` blocks matching function names
- Test edge cases: null/undefined inputs, empty arrays, boundary values

## Success Criteria

- Coverage increases after each experiment
- All tests pass (`npm run test` exits 0)
- Build succeeds (`npm run build` exits 0)
