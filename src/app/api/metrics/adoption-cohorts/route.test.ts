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

const getPhaseDeveloperCountsMock = vi.fn(() => [] as { phase: number; developers: number }[]);
vi.mock("@/lib/db/metrics-repo", () => ({
  countEffectiveEnterprises: vi.fn(() => 1),
  getPhaseDeveloperCounts: (...args: unknown[]) =>
    (getPhaseDeveloperCountsMock as unknown as (...a: unknown[]) => unknown)(...args),
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
  getPhaseDeveloperCountsMock.mockReturnValue([]);
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

describe("adoption-cohorts window-wide user counts", () => {
  it("counts every user active in the window, not just the final day", async () => {
    const phases = [
      makePhase(1, "Code first", 30, 40),
      makePhase(2, "Agent first", 10, 10),
    ];
    allMock.mockReturnValue([
      { day: "2026-06-26", totals_by_ai_adoption_phase: JSON.stringify(phases) },
    ]);
    // The final day reported 30/10 engaged users, but 45/15 distinct users were
    // active somewhere in the window — the August 2026 correction.
    getPhaseDeveloperCountsMock.mockReturnValue([
      { phase: 1, developers: 45 },
      { phase: 2, developers: 15 },
    ]);

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/adoption-cohorts?days=28"));
    const json = await res.json();

    expect(json.countBasis).toBe("window");
    expect(json.totalEngaged).toBe(60);

    const codeFirst = json.distribution.find((d: { phase: number }) => d.phase === 1);
    expect(codeFirst.count).toBe(45);
    expect(codeFirst.percentage).toBeCloseTo(75, 5);

    // Per-phase averages from the API are untouched — only counts change.
    expect(json.perPhaseMetrics[0].engaged_users).toBe(30);
  });

  it("falls back to the last-day snapshot when no user-level phase data exists", async () => {
    const phases = [makePhase(1, "Code first", 30, 40)];
    allMock.mockReturnValue([
      { day: "2026-06-26", totals_by_ai_adoption_phase: JSON.stringify(phases) },
    ]);
    getPhaseDeveloperCountsMock.mockReturnValue([]);

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/adoption-cohorts?days=28"));
    const json = await res.json();

    expect(json.countBasis).toBe("snapshot");
    expect(json.totalEngaged).toBe(30);
    expect(json.distribution[0].count).toBe(30);
  });

  it("reports a zero count for a phase with no users active in the window", async () => {
    const phases = [
      makePhase(1, "Code first", 30, 40),
      makePhase(3, "Multi-agent", 5, 5),
    ];
    allMock.mockReturnValue([
      { day: "2026-06-26", totals_by_ai_adoption_phase: JSON.stringify(phases) },
    ]);
    getPhaseDeveloperCountsMock.mockReturnValue([{ phase: 1, developers: 45 }]);

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/adoption-cohorts?days=28"));
    const json = await res.json();

    const multiAgent = json.distribution.find((d: { phase: number }) => d.phase === 3);
    expect(multiAgent.count).toBe(0);
    expect(json.totalEngaged).toBe(45);
  });
});
