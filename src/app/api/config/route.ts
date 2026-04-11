import { NextResponse } from "next/server";
import { getDashboardConfig } from "@/lib/config/dashboard-config";

export async function GET() {
  return NextResponse.json(getDashboardConfig());
}
