import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseSlugs } from "@/lib/config/enterprise-config";
import {
  getLicenseRun,
  listLicenseChecks,
  listLicenseSourceState,
  buildLicenseRunReport,
  serializeLicenseRunReport,
  renderLicenseRunReportText,
} from "@/lib/db/license-run-repo";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";

const NOT_FOUND_BODY = { error: "Run not found" } as const;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, no-cache, max-age=0" };

function notFound() {
  return NextResponse.json(NOT_FOUND_BODY, { status: 404, headers: NO_STORE_HEADERS });
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const enterprise = params.get("enterprise");
    if (!enterprise) {
      return NextResponse.json(
        { error: "enterprise query parameter is required." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    if (!getEnterpriseSlugs().includes(enterprise)) {
      return NextResponse.json(
        { error: `Unknown enterprise "${enterprise}".` },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const format = params.get("format") || "json";
    if (format !== "json" && format !== "text") {
      return NextResponse.json(
        { error: `Invalid format "${format}". Expected one of: json, text.` },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    // Extract the dynamic [id] path segment manually (matching this
    // codebase's existing dynamic-route convention, e.g.
    // `src/app/api/teams/[slug]/route.ts`), rather than a Next.js
    // `context.params` handler argument.
    const segments = request.nextUrl.pathname.split("/").filter(Boolean);
    const id = decodeURIComponent(segments[segments.length - 1] || "");
    if (!id) {
      return notFound();
    }

    const run = getLicenseRun(id);
    // Unknown id and a run that belongs to a different enterprise than
    // requested both resolve to an identical 404 body — never leak whether
    // an id exists under a different enterprise's scope.
    if (!run || run.enterpriseSlug !== enterprise) {
      return notFound();
    }

    const checks = listLicenseChecks(run.id);
    const sourceStates = listLicenseSourceState(run.enterpriseSlug);
    const report = buildLicenseRunReport(run, checks, sourceStates);

    if (format === "text") {
      return new NextResponse(renderLicenseRunReportText(report), {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE_HEADERS },
      });
    }

    return new NextResponse(serializeLicenseRunReport(report), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE_HEADERS },
    });
  } catch (err) {
    console.error("License reconciliation run detail error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export const GET = withRateLimit(withTimeout(handler));
