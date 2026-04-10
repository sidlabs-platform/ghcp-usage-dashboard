import { NextResponse } from "next/server";
import { getAllSeats, getSeatStats } from "@/lib/db/seats-repo";

export async function GET() {
  try {
    const seats = getAllSeats();
    const stats = getSeatStats();
    const utilization = stats.total > 0
      ? Number(((stats.active30d / stats.total) * 100).toFixed(1))
      : 0;

    return NextResponse.json({ seats, stats, utilization }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
