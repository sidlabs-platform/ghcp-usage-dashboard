// Token ↔ AI Credit correlation, cache-savings and anomaly analysis.
//
// All functions here are pure and operate on already-aggregated rows produced by
// the SQL rollups in `src/lib/db/billing-repo.ts`, so the matrices involved are
// small (models × days, users × models).
//
// Background: GitHub's AI usage report exposes a per-model token breakdown
// (`input`, `output`, `cache_read`, `cache_write`) alongside the AI credits each
// model consumed. Credits are not a published linear function of tokens, so the
// implied per-token rates below are *estimates* fitted from observed data and
// are presented as such in the UI.

import type { TokenModelDailyPoint } from "@/lib/types/billing";

const MILLION = 1_000_000;

/** The four token classes, in a fixed order used by the regression. */
export const TOKEN_KINDS = ["input", "output", "cache_read", "cache_write"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface CorrelationPoint {
  model: string;
  day: string;
  totalTokens: number;
  credits: number;
}

export interface ModelFit {
  model: string;
  /** Observations used for the fit. */
  samples: number;
  /** Pearson correlation between total tokens and credits (0 when undefined). */
  r: number;
  /**
   * Implied credits consumed per 1M tokens of each kind, fitted with
   * non-negative least squares. Null when the fit is not identifiable
   * (too few observations or degenerate inputs).
   */
  ratesPerMTok: Record<TokenKind, number> | null;
  /** Observed credits per 1M total tokens. */
  observedCreditsPerMTok: number;
  /**
   * Signed relative deviation of observed credits versus the credits predicted
   * by the *fleet-wide* fit, as a fraction. Positive ⇒ costlier than its token
   * profile suggests. Null when no fleet prediction is available.
   */
  deviation: number | null;
}

export interface CorrelationResult {
  /** Pearson r across every observation. */
  overallR: number;
  /** Fleet-wide implied credits per 1M tokens, by token kind. */
  fleetRatesPerMTok: Record<TokenKind, number> | null;
  points: CorrelationPoint[];
  models: ModelFit[];
}

export interface CacheSavings {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  /** cache_read / (input + cache_read) as a percentage. */
  hitRate: number;
  /**
   * Estimated credits avoided by reading from cache instead of re-sending the
   * tokens as fresh input, valued at the difference between the fitted input
   * and cache-read rates. Null when no input rate could be fitted, or when the
   * fit does not price cache reads below fresh input (in which case the data
   * cannot substantiate a saving).
   */
  creditsAvoided: number | null;
  usdAvoided: number | null;
  /** USD per credit implied by the data, used to convert the estimate. */
  usdPerCredit: number;
}

export type AnomalyKind = "model_efficiency" | "user_efficiency" | "daily_spike";

export interface Anomaly {
  kind: AnomalyKind;
  /** Model name, username, or date depending on `kind`. */
  subject: string;
  /** Secondary label (e.g. the model for a user anomaly). */
  context?: string;
  /** Observed credits per 1M tokens, or total credits for a daily spike. */
  value: number;
  /** Peer median the value is compared against. */
  baseline: number;
  /** Robust z-score (median absolute deviation based). */
  score: number;
  direction: "high" | "low";
  description: string;
}

// ── Math helpers ──────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Median absolute deviation, scaled to be a consistent estimator of sigma. */
function mad(values: number[], center: number): number {
  if (values.length === 0) return 0;
  return 1.4826 * median(values.map((v) => Math.abs(v - center)));
}

/** Mean absolute deviation about `center`. */
function meanAbsoluteDeviation(values: number[], center: number): number {
  if (values.length === 0) return 0;
  return values.reduce((a, v) => a + Math.abs(v - center), 0) / values.length;
}

/**
 * Robust scale estimate used to normalise deviations.
 *
 * MAD is preferred, but it degenerates to exactly zero whenever more than half
 * the sample shares the same value — which is the common case here, e.g. a
 * fleet of models that all sit at the same credits-per-token rate plus one
 * runaway. A zero scale would make every deviation infinite/undefined and, as
 * implemented, would suppress the outlier entirely. Fall back to the mean
 * absolute deviation, which is only zero when *every* value is identical — in
 * which case there genuinely is no outlier.
 */
function robustScale(values: number[], center: number): number {
  const m = mad(values, center);
  if (m > 0) return m;
  return meanAbsoluteDeviation(values, center);
}

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  if (!Number.isFinite(den) || den === 0) return 0;
  const r = num / den;
  return Number.isFinite(r) ? r : 0;
}

/**
 * Non-negative least squares for a small, fixed-width design matrix, solved with
 * projected gradient descent.
 *
 * Credit rates cannot be negative, so an unconstrained OLS fit would be
 * physically meaningless (and unstable, since the token kinds are highly
 * collinear). Coefficients are clamped at zero on every step.
 *
 * Callers scale columns to millions of tokens so the coefficients come out as
 * "credits per 1M tokens" and the problem stays well conditioned.
 */
export function nnls(design: number[][], target: number[], iterations = 500): number[] | null {
  const rows = design.length;
  if (rows === 0 || target.length !== rows) return null;
  const cols = design[0].length;
  if (cols === 0) return null;
  // Need at least as many observations as unknowns for a meaningful fit.
  if (rows < cols) return null;

  // Bail out if every predictor is zero — nothing to fit.
  if (!design.some((row) => row.some((v) => v > 0))) return null;

  let maxSq = 0;
  for (const row of design) {
    let s = 0;
    for (const v of row) s += v * v;
    maxSq = Math.max(maxSq, s);
  }
  if (maxSq === 0) return null;
  const step = 1 / (maxSq * rows);

  const beta = new Array<number>(cols).fill(0);
  for (let it = 0; it < iterations; it++) {
    const grad = new Array<number>(cols).fill(0);
    for (let i = 0; i < rows; i++) {
      let pred = 0;
      for (let j = 0; j < cols; j++) pred += design[i][j] * beta[j];
      const err = pred - target[i];
      for (let j = 0; j < cols; j++) grad[j] += err * design[i][j];
    }
    let moved = 0;
    for (let j = 0; j < cols; j++) {
      const next = Math.max(0, beta[j] - step * grad[j]);
      moved += Math.abs(next - beta[j]);
      beta[j] = next;
    }
    if (moved < 1e-12) break;
  }

  return beta.every((b) => Number.isFinite(b)) ? beta : null;
}

function toDesignRow(p: TokenModelDailyPoint): number[] {
  return [
    p.input_tokens / MILLION,
    p.output_tokens / MILLION,
    p.cache_read_tokens / MILLION,
    p.cache_write_tokens / MILLION,
  ];
}

function toRates(beta: number[] | null): Record<TokenKind, number> | null {
  if (!beta) return null;
  return {
    input: beta[0],
    output: beta[1],
    cache_read: beta[2],
    cache_write: beta[3],
  };
}

function predict(rates: Record<TokenKind, number>, p: TokenModelDailyPoint): number {
  return (
    (rates.input * p.input_tokens +
      rates.output * p.output_tokens +
      rates.cache_read * p.cache_read_tokens +
      rates.cache_write * p.cache_write_tokens) /
    MILLION
  );
}

// ── Public analysis ───────────────────────────────────────────────────

/**
 * Correlate token consumption against AI credits, overall and per model.
 *
 * Returns a zeroed result rather than throwing when there is no token data, so
 * callers can render an empty state without special-casing.
 */
export function analyzeCorrelation(series: TokenModelDailyPoint[]): CorrelationResult {
  const usable = series.filter((p) => p.total_tokens > 0);
  if (usable.length === 0) {
    return { overallR: 0, fleetRatesPerMTok: null, points: [], models: [] };
  }

  const overallR = pearson(
    usable.map((p) => p.total_tokens),
    usable.map((p) => p.total_credits)
  );

  const fleetRates = toRates(
    nnls(
      usable.map(toDesignRow),
      usable.map((p) => p.total_credits)
    )
  );

  const byModel = new Map<string, TokenModelDailyPoint[]>();
  for (const p of usable) {
    const list = byModel.get(p.model);
    if (list) list.push(p);
    else byModel.set(p.model, [p]);
  }

  const models: ModelFit[] = [...byModel.entries()]
    .map(([model, pts]) => {
      const tokens = pts.reduce((a, p) => a + p.total_tokens, 0);
      const credits = pts.reduce((a, p) => a + p.total_credits, 0);

      let deviation: number | null = null;
      if (fleetRates) {
        const predicted = pts.reduce((a, p) => a + predict(fleetRates, p), 0);
        deviation = predicted > 0 ? (credits - predicted) / predicted : null;
      }

      return {
        model,
        samples: pts.length,
        r: pearson(
          pts.map((p) => p.total_tokens),
          pts.map((p) => p.total_credits)
        ),
        ratesPerMTok: toRates(
          nnls(
            pts.map(toDesignRow),
            pts.map((p) => p.total_credits)
          )
        ),
        observedCreditsPerMTok: tokens > 0 ? (credits * MILLION) / tokens : 0,
        deviation,
      };
    })
    .sort((a, b) => b.observedCreditsPerMTok - a.observedCreditsPerMTok);

  return {
    overallR,
    fleetRatesPerMTok: fleetRates,
    points: usable.map((p) => ({
      model: p.model,
      day: p.day,
      totalTokens: p.total_tokens,
      credits: p.total_credits,
    })),
    models,
  };
}

/**
 * Estimate the credits and USD avoided by cache reads.
 *
 * Cached tokens are valued at the *difference* between the fitted input rate and
 * the fitted cache-read rate, since a cache read substitutes for re-sending
 * those tokens as fresh (more expensive) input.
 */
export function analyzeCacheSavings(
  series: TokenModelDailyPoint[],
  fleetRates: Record<TokenKind, number> | null
): CacheSavings {
  const cacheReadTokens = series.reduce((a, p) => a + p.cache_read_tokens, 0);
  const cacheWriteTokens = series.reduce((a, p) => a + p.cache_write_tokens, 0);
  const inputTokens = series.reduce((a, p) => a + p.input_tokens, 0);
  const credits = series.reduce((a, p) => a + p.total_credits, 0);
  const usd = series.reduce((a, p) => a + p.total_gross_usd, 0);
  const usdPerCredit = credits > 0 ? usd / credits : 0;

  const denominator = inputTokens + cacheReadTokens;
  const hitRate = denominator > 0 ? (cacheReadTokens * 100) / denominator : 0;

  let creditsAvoided: number | null = null;
  if (fleetRates && fleetRates.input > fleetRates.cache_read) {
    // Only meaningful when the fit actually prices cache reads below fresh
    // input. The four token kinds are highly collinear, so on fleets where
    // cache reads dominate volume the fit can load most of the cost onto
    // cache_read — in that case the data cannot substantiate a saving and we
    // report `null` ("unknown") rather than a misleading 0.
    const delta = fleetRates.input - fleetRates.cache_read;
    creditsAvoided = (delta * cacheReadTokens) / MILLION;
  }

  return {
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    hitRate,
    creditsAvoided,
    usdAvoided: creditsAvoided === null ? null : creditsAvoided * usdPerCredit,
    usdPerCredit,
  };
}

interface EfficiencyRow {
  subject: string;
  context?: string;
  tokens: number;
  credits: number;
}

/**
 * Flag rows whose credits-per-1M-tokens deviate sharply from the peer median,
 * using a median/MAD robust z-score so a handful of extreme values cannot mask
 * the rest.
 */
function detectEfficiencyOutliers(
  rows: EfficiencyRow[],
  kind: AnomalyKind,
  threshold: number,
  minRows: number
): Anomaly[] {
  const usable = rows.filter((r) => r.tokens > 0);
  if (usable.length < minRows) return [];

  const rates = usable.map((r) => (r.credits * MILLION) / r.tokens);
  const center = median(rates);
  const spread = robustScale(rates, center);
  if (spread <= 0) return [];

  const out: Anomaly[] = [];
  usable.forEach((r, i) => {
    const score = (rates[i] - center) / spread;
    if (Math.abs(score) < threshold) return;
    const direction = score > 0 ? "high" : "low";
    out.push({
      kind,
      subject: r.subject,
      context: r.context,
      value: rates[i],
      baseline: center,
      score,
      direction,
      description:
        direction === "high"
          ? `Consumes ${rates[i].toFixed(1)} credits per 1M tokens versus a peer median of ${center.toFixed(1)} — ${(rates[i] / (center || 1)).toFixed(1)}x the typical rate.`
          : `Consumes only ${rates[i].toFixed(1)} credits per 1M tokens versus a peer median of ${center.toFixed(1)}.`,
    });
  });

  return out.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

/** Detect day-over-day credit spikes in the daily totals. */
function detectDailySpikes(series: TokenModelDailyPoint[], threshold: number): Anomaly[] {
  const byDay = new Map<string, number>();
  for (const p of series) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.total_credits);
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (days.length < 5) return [];

  const values = days.map(([, v]) => v);
  const center = median(values);
  const spread = robustScale(values, center);
  if (spread <= 0) return [];

  return days
    .map(([day, value]) => ({ day, value, score: (value - center) / spread }))
    .filter((d) => d.score >= threshold)
    .map<Anomaly>((d) => ({
      kind: "daily_spike",
      subject: d.day,
      value: d.value,
      baseline: center,
      score: d.score,
      direction: "high",
      description: `${d.value.toFixed(0)} credits consumed, versus a typical day of ${center.toFixed(0)}.`,
    }))
    .sort((a, b) => b.score - a.score);
}

export interface AnomalyInput {
  modelDaily: TokenModelDailyPoint[];
  userModel: { username: string; model: string; total_tokens: number; total_credits: number }[];
}

/** Run all anomaly detectors and return the combined, severity-sorted list. */
export function detectAnomalies(input: AnomalyInput, threshold = 3.5, limit = 25): Anomaly[] {
  const modelTotals = new Map<string, { tokens: number; credits: number }>();
  for (const p of input.modelDaily) {
    const cur = modelTotals.get(p.model) ?? { tokens: 0, credits: 0 };
    cur.tokens += p.total_tokens;
    cur.credits += p.total_credits;
    modelTotals.set(p.model, cur);
  }

  const modelAnomalies = detectEfficiencyOutliers(
    [...modelTotals.entries()].map(([subject, v]) => ({
      subject,
      tokens: v.tokens,
      credits: v.credits,
    })),
    "model_efficiency",
    threshold,
    4
  );

  const userAnomalies = detectEfficiencyOutliers(
    input.userModel.map((r) => ({
      subject: r.username || "(unattributed)",
      context: r.model,
      tokens: r.total_tokens,
      credits: r.total_credits,
    })),
    "user_efficiency",
    threshold,
    8
  );

  const spikes = detectDailySpikes(input.modelDaily, threshold);

  return [...modelAnomalies, ...userAnomalies, ...spikes]
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, limit);
}
