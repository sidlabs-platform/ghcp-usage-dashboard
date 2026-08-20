import { cn, formatNumber, formatPercent, safeNum } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/Sparkline";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ─── State ramp ────────────────────────────────────────────────────────────────
//
// These four states encode meaning ("is this good or bad?") independently of
// the series-identity colours used in charts.  Never share a token between
// both systems.
//
/**
 * Semantic state for a metric card accent.
 * - `good`    — value is healthy; green left-border.
 * - `watch`   — approaching a threshold; amber left-border.
 * - `bad`     — value requires attention; red left-border.
 * - `neutral` — no direction (e.g. count metrics); slate left-border.
 */
export type MetricState = "good" | "watch" | "bad" | "neutral";

/**
 * Threshold definition for threshold-driven accent computation.
 *
 * Supply either `good` + `bad` (with `watch` between them) or just `bad`.
 * The comparison direction is controlled by `higherIsBetter` (default `true`).
 *
 * @example
 * // License utilization: < 60% is bad, 60–80% is watch, > 80% is good
 * thresholds={{ good: 80, bad: 60, higherIsBetter: true }}
 *
 * @example
 * // Error rate: < 5% is good, 5–15% is watch, > 15% is bad
 * thresholds={{ good: 5, bad: 15, higherIsBetter: false }}
 */
export interface MetricThresholds {
  /** Value at or above (higherIsBetter) / below (lowerIsBetter) which state is "good". */
  good: number;
  /** Value below (higherIsBetter) / at or above (lowerIsBetter) which state is "bad". */
  bad: number;
  /** Default `true`. When false, lower values are better (e.g. error rates). */
  higherIsBetter?: boolean;
}

// ─── Legacy presentational accent (kept for backward compat) ──────────────────
// Existing call sites may still pass a named colour string.  New call sites
// should pass `intent` or `thresholds` instead.
type LegacyAccent = "blue" | "green" | "amber" | "violet" | "red" | "teal";

interface MetricCardProps {
  title: string;
  value: number | string;
  format?: "number" | "percent" | "raw";
  delta?: { value: number; label?: string };
  icon?: React.ReactNode;
  className?: string;
  subtitle?: string;
  /**
   * @deprecated Pass `intent` or `thresholds` for semantic accents.
   * Kept for backward compatibility with existing call sites.
   */
  accent?: LegacyAccent;
  /**
   * Explicit semantic state.  Takes precedence over `accent` and `thresholds`.
   * Use when the caller already knows whether the value is good/bad/etc.
   */
  intent?: MetricState;
  /**
   * Threshold-driven accent.  When supplied, the accent is derived from the
   * numeric `value` against these thresholds — the caller no longer needs to
   * hard-code a colour.  Ignored when `intent` is also supplied.
   *
   * Requires `value` to be a `number`; silently falls through to `accent` or
   * no-accent when `value` is a string (raw display values).
   */
  thresholds?: MetricThresholds;
  trend?: number[];
  trendColor?: string;
  stagger?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
}

// ─── State ramp maps ──────────────────────────────────────────────────────────

const stateToTailwindBorder: Record<MetricState, string> = {
  good:    "border-l-emerald-500",
  watch:   "border-l-amber-500",
  bad:     "border-l-red-500",
  neutral: "border-l-slate-400",
};

const stateToHex: Record<MetricState, string> = {
  good:    "#10b981",
  watch:   "#f59e0b",
  bad:     "#ef4444",
  neutral: "#94a3b8",
};

const stateToGlow: Record<MetricState, string> = {
  good:    "shadow-[inset_3px_0_8px_-4px_rgba(16,185,129,0.4)]",
  watch:   "shadow-[inset_3px_0_8px_-4px_rgba(245,158,11,0.4)]",
  bad:     "shadow-[inset_3px_0_8px_-4px_rgba(239,68,68,0.4)]",
  neutral: "shadow-[inset_3px_0_8px_-4px_rgba(148,163,184,0.3)]",
};

// ─── Legacy accent maps (backward compat) ─────────────────────────────────────

const legacyAccentBorder: Record<LegacyAccent, string> = {
  blue:   "border-l-blue-500",
  green:  "border-l-emerald-500",
  amber:  "border-l-amber-500",
  violet: "border-l-violet-500",
  red:    "border-l-red-500",
  teal:   "border-l-teal-500",
};

const legacyAccentHex: Record<LegacyAccent, string> = {
  blue:   "#3b82f6",
  green:  "#10b981",
  amber:  "#f59e0b",
  violet: "#8b5cf6",
  red:    "#ef4444",
  teal:   "#14b8a6",
};

const legacyAccentGlow: Record<LegacyAccent, string> = {
  blue:   "shadow-[inset_3px_0_8px_-4px_rgba(59,130,246,0.4)]",
  green:  "shadow-[inset_3px_0_8px_-4px_rgba(16,185,129,0.4)]",
  amber:  "shadow-[inset_3px_0_8px_-4px_rgba(245,158,11,0.4)]",
  violet: "shadow-[inset_3px_0_8px_-4px_rgba(139,92,246,0.4)]",
  red:    "shadow-[inset_3px_0_8px_-4px_rgba(239,68,68,0.4)]",
  teal:   "shadow-[inset_3px_0_8px_-4px_rgba(20,184,166,0.4)]",
};

// ─── Threshold helper ─────────────────────────────────────────────────────────

/**
 * Derive a semantic state from a numeric value and a threshold definition.
 *
 * @param value           - The numeric metric value.
 * @param thresholds      - Threshold configuration (see `MetricThresholds`).
 * @returns               - "good" | "watch" | "bad"
 */
export function deriveMetricState(value: number, thresholds: MetricThresholds): MetricState {
  const { good, bad, higherIsBetter = true } = thresholds;
  if (higherIsBetter) {
    if (value >= good) return "good";
    if (value < bad)   return "bad";
    return "watch";
  } else {
    if (value <= good) return "good";
    if (value > bad)   return "bad";
    return "watch";
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Metric summary card with optional semantic state accent.
 *
 * Accent priority (highest to lowest):
 * 1. `intent` — caller-supplied explicit state.
 * 2. `thresholds` — derived state from numeric value + threshold config.
 * 3. `accent` — legacy named colour (backward-compatible, presentational only).
 *
 * For any metric with a good/bad direction (e.g. license utilization, error
 * rate, acceptance rate) **pass `thresholds` instead of `accent`** so the
 * border colour reflects the actual value rather than a hard-coded decorator.
 */
export function MetricCard({
  title,
  value,
  format = "number",
  delta,
  icon,
  className,
  subtitle,
  accent,
  intent,
  thresholds,
  trend,
  trendColor,
  stagger,
}: MetricCardProps) {
  // "raw" means "display the exact value" — it must never be abbreviated
  // (e.g. 3456 -> "3.5K"), only locale-formatted (e.g. 3456 -> "3,456"),
  // unlike the default "number" format which abbreviates large values.
  const displayValue =
    typeof value === "string"
      ? value
      : format === "percent"
        ? formatPercent(value)
        : format === "raw"
          ? value.toLocaleString()
          : formatNumber(value);

  // Exact numeric value for the tooltip — reveals the true figure behind
  // abbreviated display strings such as "3.5K".
  const exactTitle =
    typeof value === "number" ? value.toLocaleString() : undefined;

  // ── Resolve effective state ────────────────────────────────────────────────
  // intent > threshold-derived > no semantic state
  const derivedIntent: MetricState | undefined =
    intent ??
    (thresholds !== undefined && typeof value === "number"
      ? deriveMetricState(value, thresholds)
      : undefined);

  // ── Resolve border / hex / glow ───────────────────────────────────────────
  let borderClass: string | undefined;
  let hexColor: string;
  let glowClass: string | undefined;

  if (derivedIntent !== undefined) {
    borderClass = stateToTailwindBorder[derivedIntent];
    hexColor    = stateToHex[derivedIntent];
    glowClass   = stateToGlow[derivedIntent];
  } else if (accent !== undefined) {
    borderClass = legacyAccentBorder[accent];
    hexColor    = legacyAccentHex[accent];
    glowClass   = legacyAccentGlow[accent];
  } else {
    hexColor = "#3b82f6";
  }

  const sparkColor = trendColor ?? hexColor;
  const hasLeftBorder = borderClass !== undefined;

  return (
    <Card
      className={cn(
        "group relative overflow-hidden transition-shadow duration-300 hover:shadow-[var(--card-hover-shadow)]",
        hasLeftBorder && `border-l-[3px] ${borderClass} ${glowClass}`,
        stagger && `animate-fade-in-up stagger-${stagger}`,
        className,
      )}
    >
      {/* Decorative sparkline background */}
      {trend && trend.length > 1 && (
        <div className="pointer-events-none absolute bottom-0 right-0 w-1/2 opacity-[0.18]">
          <Sparkline data={trend} color={sparkColor} height={40} />
        </div>
      )}

      <div className="relative p-6">
        <div className="flex items-center justify-between">
          {/*
           * Accessibility: the card label is the heading so screen-reader
           * heading navigation reads meaningful text, not bare numbers.
           * The numeric value is NOT a heading — it is a data point beneath it.
           */}
          <h3 className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{title}</h3>
          {icon && (
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[hsl(var(--primary))]"
              style={{
                background: `linear-gradient(135deg, ${hexColor}1a, ${hexColor}0d)`,
              }}
            >
              {icon}
            </div>
          )}
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          {/*
           * `title` attribute reveals the exact numeric figure on hover,
           * useful for abbreviated display values such as "3.5K".
           */}
          <p
            className="tabular-nums text-3xl font-bold tracking-tight"
            title={exactTitle}
            aria-label={exactTitle ? `${title}: ${exactTitle}` : undefined}
          >
            {displayValue}
          </p>
          {delta && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
                delta.value > 0
                  ? "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
                  : delta.value < 0
                    ? "bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400"
                    : "bg-[hsl(var(--muted-foreground))]/10 text-[hsl(var(--muted-foreground))]",
              )}
            >
              {delta.value > 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : delta.value < 0 ? (
                <TrendingDown className="h-3 w-3" />
              ) : (
                <Minus className="h-3 w-3" />
              )}
              {delta.value > 0 ? "+" : ""}
              {safeNum(delta.value).toFixed(1)}%
            </span>
          )}
        </div>

        {subtitle && (
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{subtitle}</p>
        )}
      </div>
    </Card>
  );
}
