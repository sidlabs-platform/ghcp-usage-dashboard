# Program: bug-hunting

## Goal

Find and fix real bugs — logic errors, unhandled edge cases, silent failures,
and data-integrity risks — that could cause runtime crashes or incorrect results.

## Strategy

1. **Silent error swallowing** — catch blocks that discard errors without logging or re-throwing
2. **Null / undefined guards** — missing checks on API responses, DB results, parsed JSON
3. **Input validation** — API routes accepting malformed query params without 400 responses
4. **parseInt / parseFloat without NaN guards** — can propagate NaN through calculations
5. **SQL safety** — string interpolation in queries, missing parameterization
6. **Race conditions** — shared mutable state in caches or singletons
7. **Resource leaks** — missing cleanup in error paths, unclosed connections
8. **Type coercion** — loose equality (==), implicit toString, string ↔ number confusion

## Priority Order

1. Bugs that cause data corruption or silent wrong answers (high severity)
2. Bugs that cause runtime crashes (medium severity)
3. Bugs that cause degraded behaviour (low severity)

## Conventions

- Each fix ≤ 50 lines changed
- Single concern per commit
- Must pass build (`npm run build`) and tests (`npm test`) after every fix
- Add a regression test when practical (co-located `*.test.ts`)
- Commit message format: `fix(<scope>): <what was wrong>`

## Success Criteria

- Build passes
- All tests pass
- Coverage does not decrease
- The fix addresses a real bug (not style or preference)
