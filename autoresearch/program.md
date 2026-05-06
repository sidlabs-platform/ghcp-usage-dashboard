# AutoResearch Protocol

## Overview

Autonomous improvement loop adapted from Karpathy's autoresearch pattern.
Make the codebase measurably better through continuous small experiments.

## The Loop

```
LOOP FOREVER:
  1. Choose improvement target (based on active program)
  2. Make change (≤50 lines per experiment)
  3. git commit with descriptive message
  4. Evaluate (node scripts/autoresearch/evaluate.mjs)
  5. If metrics improved or stable → keep
     If metrics worsened → git revert HEAD
  6. Log result to autoresearch/experiments.tsv
  7. Go to 1
```

## Rules

1. **Never stop** — run until the human interrupts
2. **Max 50 lines** changed per experiment (keeps changes atomic)
3. **Single concern** per commit (one test file, one module)
4. **Never edit** `scripts/autoresearch/evaluate.mjs` or `autoresearch/program.md`
5. **Always evaluate** after each change — no assumptions
6. **Always log** every experiment, including failures
7. **No breaking changes** — build must pass after every commit

## Evaluation

Run: `node scripts/autoresearch/evaluate.mjs`

Outputs JSON with:
- `build`: pass/fail
- `tests`: pass/fail + count
- `coverage`: statement/branch/function/line percentages

## Logging

Append to `autoresearch/experiments.tsv`:
```
experiment_id	timestamp	program	description	result	coverage_before	coverage_after	notes
```

## Branch Convention

All work on `autoresearch/<tag>` branches. Never push automatically.
