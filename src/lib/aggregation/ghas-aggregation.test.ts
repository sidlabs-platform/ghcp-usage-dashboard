import { describe, it, expect } from "vitest";
import {
  computeFixRate,
  computeAutofixAdoption,
  computeTrendDirection,
  getTopEcosystems,
  getSeverityDistribution,
  computeSecuritySummary,
  formatMTTR,
} from "./ghas-aggregation";
import type { CodeScanningDaily, DependabotDaily, SecretScanningDaily } from "@/lib/types/ghas";

describe("computeFixRate", () => {
  it("returns 0 for empty data", () => {
    expect(computeFixRate([])).toBe(0);
  });

  it("computes correct percentage", () => {
    const data = [
      { opened: 10, fixed: 5 },
      { opened: 20, fixed: 15 },
    ];
    // total opened=30, fixed=20 → 66.67%
    expect(computeFixRate(data)).toBeCloseTo(66.67, 1);
  });

  it("returns 0 when total opened is 0", () => {
    expect(computeFixRate([{ opened: 0, fixed: 0 }])).toBe(0);
  });
});

describe("computeAutofixAdoption", () => {
  it("returns zeros for empty data", () => {
    const result = computeAutofixAdoption([]);
    expect(result).toEqual({ rate: 0, totalAvailable: 0, totalCommitted: 0 });
  });

  it("uses the latest day sorted by day", () => {
    const data: CodeScanningDaily[] = [
      makeCsDaily("2024-01-02", { autofix_available: 20, autofix_committed: 10 }),
      makeCsDaily("2024-01-01", { autofix_available: 5, autofix_committed: 1 }),
    ];
    const result = computeAutofixAdoption(data);
    expect(result.totalAvailable).toBe(20);
    expect(result.totalCommitted).toBe(10);
    expect(result.rate).toBe(50);
  });

  it("returns 0 rate when none available", () => {
    const data: CodeScanningDaily[] = [
      makeCsDaily("2024-01-01", { autofix_available: 0, autofix_committed: 0 }),
    ];
    expect(computeAutofixAdoption(data).rate).toBe(0);
  });
});

describe("computeTrendDirection", () => {
  it("returns flat for less than 14 values", () => {
    expect(computeTrendDirection(Array(13).fill(10))).toBe("flat");
  });

  it("returns up when recent avg exceeds prev avg by >5%", () => {
    const values = [...Array(7).fill(100), ...Array(7).fill(120)];
    expect(computeTrendDirection(values)).toBe("up");
  });

  it("returns down when recent avg is below prev avg by >5%", () => {
    const values = [...Array(7).fill(100), ...Array(7).fill(80)];
    expect(computeTrendDirection(values)).toBe("down");
  });

  it("returns flat when change is within 5%", () => {
    const values = [...Array(7).fill(100), ...Array(7).fill(103)];
    expect(computeTrendDirection(values)).toBe("flat");
  });

  it("returns up when prev avg is 0 and recent has values", () => {
    const values = [...Array(7).fill(0), ...Array(7).fill(5)];
    expect(computeTrendDirection(values)).toBe("up");
  });
});

describe("getTopEcosystems", () => {
  it("returns empty for no data", () => {
    expect(getTopEcosystems([])).toEqual([]);
  });

  it("returns top ecosystems from latest day sorted by count", () => {
    const data: DependabotDaily[] = [
      makeDepDaily("2024-01-01", { ecosystem_counts: { npm: 10, pip: 5 } }),
      makeDepDaily("2024-01-02", { ecosystem_counts: { npm: 20, pip: 15, maven: 3 } }),
    ];
    const result = getTopEcosystems(data, 2);
    expect(result).toEqual([
      { ecosystem: "npm", count: 20 },
      { ecosystem: "pip", count: 15 },
    ]);
  });
});

describe("getSeverityDistribution", () => {
  it("returns empty for no data", () => {
    expect(getSeverityDistribution([])).toEqual([]);
  });

  it("returns severity breakdown from latest entry", () => {
    const data = [
      { severity_critical: 5, severity_high: 10, severity_medium: 20, severity_low: 30 },
    ];
    const result = getSeverityDistribution(data);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ severity: "critical", count: 5, color: "#ef4444" });
    expect(result[1]).toEqual({ severity: "high", count: 10, color: "#f97316" });
  });
});

describe("computeSecuritySummary", () => {
  it("returns summary with all-zero values when no data", () => {
    const result = computeSecuritySummary([], [], []);
    expect(result.totalOpenAlerts).toBe(0);
    expect(result.fixedLast30d).toBe(0);
    expect(result.categories.codeScanning).toBeNull();
  });

  it("computes summary from mixed data", () => {
    const cs = [makeCsDaily("2024-01-01", { total_open: 5, opened: 2, fixed: 1, severity_critical: 1 })];
    const dep = [makeDepDaily("2024-01-01", { total_open: 3, opened: 1, fixed: 1, severity_high: 2 })];
    const ss: SecretScanningDaily[] = [
      { day: "2024-01-01", scope: "org", scope_id: "o", opened: 1, resolved: 1, total_open: 2, resolution_counts: {} },
    ];
    const result = computeSecuritySummary(cs, dep, ss);
    expect(result.totalOpenAlerts).toBe(10);
    expect(result.criticalAlerts).toBe(1);
    expect(result.highAlerts).toBe(2);
    expect(result.fixedLast30d).toBe(3);
    expect(result.openedLast30d).toBe(4);
    expect(result.categories.codeScanning).not.toBeNull();
    expect(result.categories.dependabot).not.toBeNull();
    expect(result.categories.secretScanning).not.toBeNull();
  });
});

describe("formatMTTR", () => {
  it("returns N/A for null", () => {
    expect(formatMTTR(null)).toBe("N/A");
  });
  it("formats sub-day as hours", () => {
    expect(formatMTTR(0.5)).toBe("12h");
  });
  it("formats days under 30", () => {
    expect(formatMTTR(5)).toBe("5.0d");
  });
  it("formats 30+ days as months", () => {
    expect(formatMTTR(60)).toBe("2.0mo");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeCsDaily(day: string, overrides: Partial<CodeScanningDaily> = {}): CodeScanningDaily {
  return {
    day, scope: "org", scope_id: "test-org",
    opened: 0, fixed: 0, dismissed: 0, reopened: 0, total_open: 0,
    severity_critical: 0, severity_high: 0, severity_medium: 0, severity_low: 0,
    autofix_available: 0, autofix_committed: 0,
    ...overrides,
  };
}

function makeDepDaily(day: string, overrides: Partial<DependabotDaily> = {}): DependabotDaily {
  return {
    day, scope: "org", scope_id: "test-org",
    opened: 0, fixed: 0, dismissed: 0, auto_dismissed: 0, total_open: 0,
    severity_critical: 0, severity_high: 0, severity_medium: 0, severity_low: 0,
    ecosystem_counts: {},
    ...overrides,
  };
}
