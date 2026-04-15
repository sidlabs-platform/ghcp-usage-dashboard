import { NextRequest, NextResponse } from "next/server";
import { syncDay } from "@/lib/db/sync-service";
import { getConfiguredEnterprises } from "@/lib/config/enterprise-config";

export async function POST(request: NextRequest) {
  try {
    const { day, enterpriseSlug } = await request.json();
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return NextResponse.json({ error: "Invalid day format. Use YYYY-MM-DD." }, { status: 400 });
    }

    // If enterpriseSlug provided, sync that one; otherwise sync all configured enterprises
    if (enterpriseSlug) {
      const result = await syncDay(enterpriseSlug, day);
      return NextResponse.json({ success: true, day, enterpriseSlug, result });
    }

    const enterprises = getConfiguredEnterprises();
    const results: Record<string, Awaited<ReturnType<typeof syncDay>>> = {};
    for (const ent of enterprises) {
      results[ent.slug] = await syncDay(ent.slug, day);
    }
    return NextResponse.json({ success: true, day, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
