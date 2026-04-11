import fs from "fs";
import path from "path";

// --- Types ---

export interface MetricConfig {
  enabled: boolean;
}

export interface SecurityConfig {
  syncIntervalMinutes: number;
  backfillDays: number;
}

export interface DashboardConfig {
  metrics: {
    copilot: MetricConfig;
    codeScanning: MetricConfig;
    dependabot: MetricConfig;
    secretScanning: MetricConfig;
  };
  security: SecurityConfig;
}

export type MetricCategory =
  | "copilot"
  | "codeScanning"
  | "dependabot"
  | "secretScanning";

// --- Defaults ---

const DEFAULT_CONFIG: DashboardConfig = {
  metrics: {
    copilot: { enabled: true },
    codeScanning: { enabled: true },
    dependabot: { enabled: true },
    secretScanning: { enabled: true },
  },
  security: {
    syncIntervalMinutes: 60,
    backfillDays: 90,
  },
};

// --- Cache ---

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedConfig: DashboardConfig | null = null;
let cacheTimestamp = 0;

// --- Public API ---

export function getDashboardConfig(): DashboardConfig {
  const now = Date.now();
  if (cachedConfig && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedConfig;
  }

  const configPath = path.join(process.cwd(), "dashboard-config.json");

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as DashboardConfig;
    cachedConfig = parsed;
    cacheTimestamp = now;
    return parsed;
  } catch (err) {
    console.warn(
      "Failed to read dashboard-config.json, using defaults:",
      err instanceof Error ? err.message : err
    );
    cachedConfig = DEFAULT_CONFIG;
    cacheTimestamp = now;
    return DEFAULT_CONFIG;
  }
}

export function isMetricEnabled(category: MetricCategory): boolean {
  const config = getDashboardConfig();
  return config.metrics[category]?.enabled ?? true;
}

export function getSecurityConfig(): SecurityConfig {
  return getDashboardConfig().security;
}
