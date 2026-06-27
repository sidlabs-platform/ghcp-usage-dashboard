import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  CACHE_TTL: { MEDIUM: 300 },
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => ({
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
    selectedTeams: [],
    selectedOrgs: [],
  })),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  countEffectiveEnterprises: vi.fn(() => 1),
}));

const allMock = vi.fn();
vi.mock("@/lib/db/database", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: allMock,
      get: vi.fn(() => undefined),
    })),
  })),
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

function makePhase(phase: number, label: string, engaged: number, merged: number) {
  return {
    phase,
    label,
    version: "v1",
    engaged_users: engaged,
    user_initiated_interaction_avg: 1,
    code_generation_activity_avg: 1,
    code_acceptance_activity_avg: 1,
    loc_added_avg: 1,
    loc_deleted_avg: 0,
    pull_requests_created_avg: 0.1,
    pull_requests_merged_avg: 0.1,
    pull_requests_reviewed_avg: 0.1,
    median_minutes_to_merge_avg: null,
    total_pull_requests_merged: merged,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("adoption-cohorts merged-by-phase", () => {
  it("aggregates total PRs merged by phase from enterprise data", async () => {
    const phases = [
      makePhase(1, "Code first", 30, 40),
      makePhase(2, "Agent first", 10, 10),
    ];
    allMock.mockReturnValue([
      { day: "2026-06-26", totals_by_ai_adoption_phase: JSON.stringify(phases) },
    ]);

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/adoption-cohorts?days=28"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.hasMergeData).toBe(true);
    expect(json.totalMerged).toBe(50);

    const codeFirst = json.mergedDistribution.find((d: { phase: number }) => d.phase === 1);
    expect(codeFirst.count).toBe(40);
    expect(codeFirst.percentage).toBeCloseTo(80, 5);

    expect(json.mergedTrend).toHaveLength(1);
    expect(json.mergedTrend[0]).toMatchObject({ day: "2026-06-26", phase1: 40, phase2: 10 });

    // perPhaseMetrics still carries the raw per-phase field for the table
    expect(json.perPhaseMetrics[0].total_pull_requests_merged).toBe(40);
  });

  it("degrades gracefully when total_pull_requests_merged is absent (older data)", async () => {
    const legacyPhase = {
      phase: 1,
      label: "Code first",
      version: "v1",
      engaged_users: 30,
      user_initiated_interaction_avg: 1,
      code_generation_activity_avg: 1,
      code_acceptance_activity_avg: 1,
      loc_added_avg: 1,
      loc_deleted_avg: 0,
      pull_requests_created_avg: 0.1,
      pull_requests_merged_avg: 0.1,
      pull_requests_reviewed_avg: 0.1,
      median_minutes_to_merge_avg: null,
    };
    allMock.mockReturnValue([
      { day: "2026-06-26", totals_by_ai_adoption_phase: JSON.stringify([legacyPhase]) },
    ]);

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/adoption-cohorts?days=28"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.hasData).toBe(true);
    expect(json.hasMergeData).toBe(false);
    expect(json.totalMerged).toBe(0);
    expect(json.mergedTrend).toHaveLength(0);
  });
});
