"use client";

import {
  ResponsiveContainer,
  Scatter,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { CorrelationPoint, TokenKind } from "@/lib/analysis/token-credits";

interface TokenCorrelationChartProps {
  points: CorrelationPoint[];
  /**
   * Fleet-wide fitted credits per 1M tokens, shown as a caption under the
   * chart. `null` when the fit was not identifiable. This does NOT drive the
   * reference line — that is the observed overall credits/tokens ratio, which
   * is always defined whenever there is any usage at all.
   */
  fleetRatesPerMTok: Record<TokenKind, number> | null;
  overallR: number;
}

const fmtTokens = (v: number) =>
  v >= 1_000_000_000
    ? `${(v / 1_000_000_000).toFixed(1)}B`
    : v >= 1_000_000
      ? `${(v / 1_000_000).toFixed(1)}M`
      : v >= 1_000
        ? `${(v / 1_000).toFixed(1)}K`
        : String(v);

/**
 * Scatter of total tokens against AI credits for every model/day observation,
 * with the observed fleet-average rate (total credits / total tokens) drawn
 * through it. Points well above the line consume more credits than their token
 * volume alone would suggest. The per-kind fitted rates are reported separately
 * in the caption.
 */
export function TokenCorrelationChart({ points, fleetRatesPerMTok, overallR }: TokenCorrelationChartProps) {
  if (!points || points.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-[hsl(var(--muted-foreground))]">
        No correlation data available
      </div>
    );
  }

  const maxTokens = Math.max(...points.map((p) => p.totalTokens));
  const totalTokens = points.reduce((a, p) => a + p.totalTokens, 0);
  const totalCredits = points.reduce((a, p) => a + p.credits, 0);
  // Average rate over the whole fleet; falls back to the observed ratio when no
  // per-kind fit was identifiable.
  const avgRatePerToken = totalTokens > 0 ? totalCredits / totalTokens : 0;

  const fitLine =
    avgRatePerToken > 0
      ? [
          { totalTokens: 0, fit: 0 },
          { totalTokens: maxTokens, fit: maxTokens * avgRatePerToken },
        ]
      : [];

  const scatterData = points.map((p) => ({ ...p, fit: undefined as number | undefined }));

  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart margin={{ top: 10, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            type="number"
            dataKey="totalTokens"
            name="Total tokens"
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickFormatter={fmtTokens}
            label={{ value: "Total tokens", position: "insideBottom", offset: -10, fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          />
          <YAxis
            type="number"
            dataKey="credits"
            name="AI credits"
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickFormatter={fmtTokens}
          />
          <ZAxis range={[40, 40]} />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "8px",
            }}
            formatter={(value: number, name: string) => [
              Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }),
              name,
            ]}
            labelFormatter={() => ""}
          />
          <Legend />
          <Scatter
            name="Model / day"
            data={scatterData}
            fill="#8b5cf6"
            fillOpacity={0.65}
          />
          {fitLine.length > 0 && (
            <Line
              name="Fleet average rate"
              data={fitLine}
              dataKey="fit"
              type="linear"
              stroke="#ef4444"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              legendType="line"
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        Pearson r = <span className="font-medium tabular-nums">{overallR.toFixed(3)}</span>
        {fleetRatesPerMTok && (
          <>
            {" · "}Fitted rates per 1M tokens (estimated, not published):{" "}
            input {fleetRatesPerMTok.input.toFixed(2)}, output {fleetRatesPerMTok.output.toFixed(2)},
            cache read {fleetRatesPerMTok.cache_read.toFixed(2)}, cache write {fleetRatesPerMTok.cache_write.toFixed(2)}
          </>
        )}
      </p>
    </div>
  );
}
