import { NextRequest, NextResponse } from "next/server";
import { syncDay } from "@/lib/db/sync-service";

export async function POST(request: NextRequest) {
  try {
    const { day } = await request.json();
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return NextResponse.json({ error: "Invalid day format. Use YYYY-MM-DD." }, { status: 400 });
    }

    const result = await syncDay(day);
    return NextResponse.json({ success: true, day, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
