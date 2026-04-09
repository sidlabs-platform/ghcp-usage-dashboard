import { NextResponse } from "next/server";
import { getSyncStatus } from "@/lib/db/metrics-repo";

export async function GET() {
  try {
    const status = getSyncStatus();
    return NextResponse.json({ success: true, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
