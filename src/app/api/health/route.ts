import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * Health check endpoint for container orchestration.
 *
 * GET /api/health          → liveness (always 200 if process is up)
 * GET /api/health?ready=1  → readiness (checks DB dir writable + schema files present)
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const readyCheck = url.searchParams.get("ready") === "1";

  if (!readyCheck) {
    return NextResponse.json({ status: "ok" });
  }

  const checks: Record<string, boolean> = {};

  // Check data directory is writable
  const dataDir = path.join(process.cwd(), "data");
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.accessSync(dataDir, fs.constants.W_OK);
    checks.dataDir = true;
  } catch {
    checks.dataDir = false;
  }

  // Check schema files are present
  const schemaFiles = [
    "schema.sql",
    "ghas-schema.sql",
    "summary-schema.sql",
    "billing-schema.sql",
  ];
  const schemaDir = path.join(process.cwd(), "src", "lib", "db");
  checks.schemaFiles = schemaFiles.every((f) =>
    fs.existsSync(path.join(schemaDir, f))
  );

  // Check dashboard config exists (non-fatal — runtime falls back to defaults)
  const configPath = path.join(process.cwd(), "dashboard-config.json");
  checks.dashboardConfig = fs.existsSync(configPath);

  // dashboardConfig is informational only — don't fail readiness when missing
  const requiredChecks = { dataDir: checks.dataDir, schemaFiles: checks.schemaFiles };
  const allHealthy = Object.values(requiredChecks).every(Boolean);

  return NextResponse.json(
    { status: allHealthy ? "ok" : "degraded", checks },
    { status: allHealthy ? 200 : 503 }
  );
}
