import { describe, it, expect } from "vitest";
import {
  pearson,
  nnls,
  analyzeCorrelation,
  analyzeCacheSavings,
  detectAnomalies,
} from "./token-credits";
import type { TokenModelDailyPoint } from "@/lib/types/billing";

function point(overrides: Partial<TokenModelDailyPoint> = {}): TokenModelDailyPoint {
  const input_tokens = overrides.input_tokens ?? 0;
  const output_tokens = overrides.output_tokens ?? 0;
  const cache_read_tokens = overrides.cache_read_tokens ?? 0;
  const cache_write_tokens = overrides.cache_write_tokens ?? 0;
  return {
    day: "2026-08-01",
    model: "model-a",
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
    total_tokens:
      overrides.total_tokens ??
      input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
    total_credits: overrides.total_credits ?? 0,
    total_gross_usd: overrides.total_gross_usd ?? 0,
    ...overrides,
  };
}

describe("pearson", () => {
  it("returns 1 for a perfectly increasing relationship", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
  });

  it("returns -1 for a perfectly decreasing relationship", () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });

  it("returns 0 for fewer than two observations", () => {
    expect(pearson([1], [2])).toBe(0);
    expect(pearson([], [])).toBe(0);
  });

  it("returns 0 when a series has zero variance", () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });

  it("ignores trailing values when the series lengths differ", () => {
    expect(pearson([1, 2, 3], [2, 4, 6, 99])).toBeCloseTo(1, 6);
  });
});

describe("nnls", () => {
  it("recovers known non-negative coefficients", () => {
    // credits = 2*input + 5*output (per 1M tokens)
    const design = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [1, 1, 0, 0],
      [2, 1, 0, 0],
      [1, 2, 0, 0],
      [3, 1, 0, 0],
    ];
    const target = design.map((r) => 2 * r[0] + 5 * r[1]);
    const beta = nnls(design, target, 5000);
    expect(beta).not.toBeNull();
    expect(beta![0]).toBeCloseTo(2, 1);
    expect(beta![1]).toBeCloseTo(5, 1);
  });

  it("never returns a negative coefficient", () => {
    const design = [
      [1, 0, 0, 0],
      [2, 0, 0, 0],
      [3, 0, 0, 0],
      [4, 0, 0, 0],
    ];
    // A relationship that would push the coefficient negative under plain OLS.
    const target = [-5, -10, -15, -20];
    const beta = nnls(design, target);
    expect(beta).not.toBeNull();
    expect(beta!.every((b) => b >= 0)).toBe(true);
  });

  it("returns null when there are fewer observations than unknowns", () => {
    expect(nnls([[1, 2, 3, 4]], [10])).toBeNull();
  });

  it("returns null on an empty design matrix", () => {
    expect(nnls([], [])).toBeNull();
  });

  it("returns null when every predictor is zero", () => {
    const design = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    expect(nnls(design, [1, 2, 3, 4])).toBeNull();
  });

  it("returns null when target length does not match the design", () => {
    expect(
      nnls(
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [1, 1, 0, 0],
          [2, 2, 0, 0],
        ],
        [1, 2]
      )
    ).toBeNull();
  });
});

describe("analyzeCorrelation", () => {
  it("returns a zeroed result for an empty series", () => {
    const result = analyzeCorrelation([]);
    expect(result.overallR).toBe(0);
    expect(result.fleetRatesPerMTok).toBeNull();
    expect(result.points).toEqual([]);
    expect(result.models).toEqual([]);
  });

  it("ignores observations with no tokens", () => {
    const result = analyzeCorrelation([
      point({ total_tokens: 0, total_credits: 100 }),
      point({ total_tokens: 0, total_credits: 50 }),
    ]);
    expect(result.points).toEqual([]);
    expect(result.models).toEqual([]);
  });

  it("correlates tokens with credits and groups per model", () => {
    const series = [
      point({ day: "2026-08-01", model: "a", input_tokens: 1_000_000, total_credits: 10 }),
      point({ day: "2026-08-02", model: "a", input_tokens: 2_000_000, total_credits: 20 }),
      point({ day: "2026-08-03", model: "a", input_tokens: 3_000_000, total_credits: 30 }),
      point({ day: "2026-08-01", model: "b", input_tokens: 1_000_000, total_credits: 40 }),
      point({ day: "2026-08-02", model: "b", input_tokens: 2_000_000, total_credits: 80 }),
      point({ day: "2026-08-03", model: "b", input_tokens: 3_000_000, total_credits: 120 }),
    ];
    const result = analyzeCorrelation(series);

    expect(result.overallR).toBeGreaterThan(0.5);
    expect(result.models).toHaveLength(2);
    expect(result.points).toHaveLength(6);

    // Sorted by observed credits per 1M tokens, descending → b first.
    expect(result.models[0].model).toBe("b");
    expect(result.models[0].observedCreditsPerMTok).toBeCloseTo(40, 4);
    expect(result.models[1].observedCreditsPerMTok).toBeCloseTo(10, 4);
  });

  it("flags a model that costs more than its token profile predicts", () => {
    const cheap = [1, 2, 3, 4].map((i) =>
      point({ day: `2026-08-0${i}`, model: "cheap", input_tokens: i * 1_000_000, total_credits: i * 10 })
    );
    const pricey = [1, 2, 3, 4].map((i) =>
      point({ day: `2026-08-0${i}`, model: "pricey", input_tokens: i * 1_000_000, total_credits: i * 60 })
    );
    const result = analyzeCorrelation([...cheap, ...pricey]);

    const priceyFit = result.models.find((m) => m.model === "pricey")!;
    const cheapFit = result.models.find((m) => m.model === "cheap")!;
    expect(priceyFit.deviation).not.toBeNull();
    expect(priceyFit.deviation!).toBeGreaterThan(0);
    expect(cheapFit.deviation!).toBeLessThan(0);
  });

  it("handles a single-model dataset without throwing", () => {
    const result = analyzeCorrelation([
      point({ day: "2026-08-01", input_tokens: 1_000, total_credits: 1 }),
    ]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0].samples).toBe(1);
    // One observation cannot identify four unknowns.
    expect(result.models[0].ratesPerMTok).toBeNull();
  });
});

describe("analyzeCacheSavings", () => {
  it("returns zeros for an empty series", () => {
    const result = analyzeCacheSavings([], null);
    expect(result.hitRate).toBe(0);
    expect(result.creditsAvoided).toBeNull();
    expect(result.usdAvoided).toBeNull();
    expect(result.usdPerCredit).toBe(0);
  });

  it("computes the cache hit rate from input and cache_read tokens", () => {
    const result = analyzeCacheSavings(
      [point({ input_tokens: 250_000, cache_read_tokens: 750_000 })],
      null
    );
    expect(result.hitRate).toBeCloseTo(75, 6);
  });

  it("values avoided credits at the input/cache-read rate gap", () => {
    const result = analyzeCacheSavings(
      [point({ cache_read_tokens: 2_000_000, total_credits: 100, total_gross_usd: 1 })],
      { input: 10, output: 30, cache_read: 1, cache_write: 2 }
    );
    // (10 - 1) credits per 1M × 2M tokens = 18 credits
    expect(result.creditsAvoided).toBeCloseTo(18, 6);
    expect(result.usdPerCredit).toBeCloseTo(0.01, 6);
    expect(result.usdAvoided).toBeCloseTo(0.18, 6);
  });

  it("reports savings as unknown when cache reads are fitted above input", () => {
    // Verified against live octodemo data: cache_read volume dwarfs input by
    // ~22x, so NNLS loads most of the cost onto cache_read. A "0 credits
    // avoided" reading alongside a 95% hit rate would be misleading, so the
    // analysis reports null and the UI renders "—".
    const result = analyzeCacheSavings(
      [point({ cache_read_tokens: 1_000_000, total_credits: 10, total_gross_usd: 0.1 })],
      { input: 1, output: 5, cache_read: 9, cache_write: 2 }
    );
    expect(result.creditsAvoided).toBeNull();
    expect(result.usdAvoided).toBeNull();
    // The observable hit rate is still reported.
    expect(result.hitRate).toBeCloseTo(100, 6);
  });

  it("returns null savings when no input rate could be fitted", () => {
    const result = analyzeCacheSavings(
      [point({ cache_read_tokens: 1_000_000, total_credits: 10 })],
      { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    );
    expect(result.creditsAvoided).toBeNull();
  });
});

describe("detectAnomalies", () => {
  it("returns nothing when there is too little data", () => {
    expect(detectAnomalies({ modelDaily: [], userModel: [] })).toEqual([]);
  });

  it("flags a model consuming far more credits per token than its peers", () => {
    const modelDaily = [
      ...["a", "b", "c", "d", "e"].map((m) =>
        point({ model: m, input_tokens: 1_000_000, total_credits: 10 })
      ),
      point({ model: "runaway", input_tokens: 1_000_000, total_credits: 900 }),
    ];
    const anomalies = detectAnomalies({ modelDaily, userModel: [] });
    const flagged = anomalies.find((a) => a.kind === "model_efficiency");
    expect(flagged).toBeDefined();
    expect(flagged!.subject).toBe("runaway");
    expect(flagged!.direction).toBe("high");
    expect(flagged!.baseline).toBeCloseTo(10, 4);
  });

  it("does not flag anything when every peer behaves identically", () => {
    const modelDaily = ["a", "b", "c", "d", "e", "f"].map((m) =>
      point({ model: m, input_tokens: 1_000_000, total_credits: 10 })
    );
    expect(detectAnomalies({ modelDaily, userModel: [] })).toEqual([]);
  });

  it("labels an unattributed user consistently", () => {
    const userModel = [
      ...Array.from({ length: 9 }, (_, i) => ({
        username: `user${i}`,
        model: "a",
        total_tokens: 1_000_000,
        total_credits: 10,
      })),
      { username: "", model: "a", total_tokens: 1_000_000, total_credits: 5000 },
    ];
    const anomalies = detectAnomalies({ modelDaily: [], userModel });
    const flagged = anomalies.find((a) => a.kind === "user_efficiency");
    expect(flagged).toBeDefined();
    expect(flagged!.subject).toBe("(unattributed)");
    expect(flagged!.context).toBe("a");
  });

  it("flags a day with an outsized credit spike", () => {
    const modelDaily = [
      ...Array.from({ length: 8 }, (_, i) =>
        point({ day: `2026-08-0${i + 1}`, input_tokens: 1000, total_credits: 10 })
      ),
      point({ day: "2026-08-20", input_tokens: 1000, total_credits: 5000 }),
    ];
    const anomalies = detectAnomalies({ modelDaily, userModel: [] });
    const spike = anomalies.find((a) => a.kind === "daily_spike");
    expect(spike).toBeDefined();
    expect(spike!.subject).toBe("2026-08-20");
  });

  it("respects the result limit", () => {
    const userModel = [
      ...Array.from({ length: 20 }, (_, i) => ({
        username: `user${i}`,
        model: "a",
        total_tokens: 1_000_000,
        total_credits: 10,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        username: `spender${i}`,
        model: "a",
        total_tokens: 1_000_000,
        total_credits: 900 + i,
      })),
    ];
    const anomalies = detectAnomalies({ modelDaily: [], userModel }, 3.5, 5);
    expect(anomalies.length).toBeLessThanOrEqual(5);
  });
});
