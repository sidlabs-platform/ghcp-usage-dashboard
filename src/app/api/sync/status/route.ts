import { NextRequest, NextResponse } from "next/server";
import { getSyncStatus } from "@/lib/db/metrics-repo";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const enterprisesParam = params.get("enterprises");
    const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];
    const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;

    const status = getSyncStatus(enterpriseSlugs);
    return NextResponse.json({ success: true, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
