import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseSlugs } from "@/lib/config/enterprise-config";
import { getLicenseCheckCountsByRunIds, listLicenseRuns } from "@/lib/db/license-run-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Lean, safe per-run summary for the list endpoint — never the raw report's sourceStats/checks/sources/unresolvedIdentities. */
interface LicenseRunSummary {
  id: string;
  enterpriseSlug: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  requestedPeriods: string[];
  checkCounts: { pass: number; warning: number; fail: number };
  warningCount: number;
  hasError: boolean;
}

function computeElapsedMs(startedAt: string, completedAt: string | null): number | null {
  if (completedAt == null) return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  const elapsed = completed - started;
  return elapsed >= 0 ? elapsed : null;
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const enterprise = params.get("enterprise");
    if (!enterprise) {
      return NextResponse.json({ error: "enterprise query parameter is required." }, { status: 400 });
    }
    if (!getEnterpriseSlugs().includes(enterprise)) {
      return NextResponse.json({ error: `Unknown enterprise "${enterprise}".` }, { status: 400 });
    }

    const rawLimit = params.get("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit != null) {
      const parsed = Number(rawLimit);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        return NextResponse.json(
          { error: `Invalid limit parameter: value must be a positive integer (got "${rawLimit}").` },
          { status: 400 },
        );
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    const runs = listLicenseRuns(enterprise, limit);
    const checkCountsByRunId = getLicenseCheckCountsByRunIds(runs.map((run) => run.id));

    const summaries: LicenseRunSummary[] = runs.map((run) => ({
      id: run.id,
      enterpriseSlug: run.enterpriseSlug,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      elapsedMs: computeElapsedMs(run.startedAt, run.completedAt),
      requestedPeriods: [...run.requestedPeriods].sort(),
      checkCounts: checkCountsByRunId.get(run.id) ?? { pass: 0, warning: 0, fail: 0 },
      warningCount: run.warnings.length,
      hasError: run.errorMessage != null,
    }));

    return NextResponse.json(
      { enterprise, runs: summaries },
      { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=30" } },
    );
  } catch (err) {
    console.error("License reconciliation runs list error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.SHORT)));
