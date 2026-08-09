import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseSlugs } from "@/lib/config/enterprise-config";
import { listLicenseRuns, listLicenseChecks, listLicenseSourceState, buildLicenseRunReport } from "@/lib/db/license-run-repo";
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
      if (!Number.isFinite(parsed) || parsed < 1) {
        return NextResponse.json(
          { error: `Invalid limit parameter: value must be a positive integer (got "${rawLimit}").` },
          { status: 400 },
        );
      }
      limit = Math.min(Math.trunc(parsed), MAX_LIMIT);
    }

    const runs = listLicenseRuns(enterprise, limit);
    // Source sync state doesn't vary per run for a given enterprise — fetch
    // once and reuse it for every run's sanitized report, rather than
    // re-querying it per run.
    const sourceStates = listLicenseSourceState(enterprise);

    const summaries: LicenseRunSummary[] = runs.map((run) => {
      const checks = listLicenseChecks(run.id);
      // Reuse the single sanitized entry point (`buildLicenseRunReport`)
      // rather than re-deriving redaction logic here, then project only the
      // lean, safe summary fields — never the raw sourceStats/checks/
      // sources/unresolvedIdentities from the full report.
      const report = buildLicenseRunReport(run, checks, sourceStates);
      return {
        id: report.id,
        enterpriseSlug: report.enterpriseSlug,
        status: report.status,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        elapsedMs: report.elapsedMs,
        requestedPeriods: report.requestedPeriods,
        checkCounts: report.checkCounts,
        warningCount: report.warnings.length,
        hasError: report.errorMessage != null,
      };
    });

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
