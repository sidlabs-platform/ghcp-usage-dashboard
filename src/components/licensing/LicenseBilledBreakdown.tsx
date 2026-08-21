"use client";

// Period-scoped breakdown sections for the License & AI Credits Overview tab:
// AI credits by surface (SKU), billed cost by organization, and the daily net
// cost across the selected window.
//
// These replace three charts that were driven by `dashboard-config.json`
// allowances and list prices — "Allocation vs. Consumption by Plan", "Credit
// Utilization Distribution", and a config-priced org table. Those had no
// dependence on the selected period at all: the utilization denominator was a
// config constant, so the histogram was the same shape in every month.
//
// The surface split groups by `sku`, which is what separates cloud agent from
// code review from code quality. Labels come from `skuLabel()` and are purely
// cosmetic — an unrecognised SKU renders its own name with its figures intact,
// so a newly-shipped surface is never silently dropped.

import { Card } from "@/components/ui/card";
import { Building2, Layers, Info } from "lucide-react";
import { safeNum } from "@/lib/utils";
import type {
  CopilotBillingBreakdown,
  ConsumptionSkuBreakdown,
} from "@/lib/types/billing";

export interface LicenseBilledBreakdownProps {
  breakdown: CopilotBillingBreakdown | null;
  currency?: string;
  /** Human name for the selected window, so every section states its own scope. */
  windowLabel?: string;
}

const UNIT_CREDITS = "ai-credits";

/** Human name for a `unit_type`, so a quantity is never shown unlabelled. */
function unitLabel(unit: string): string {
  if (unit === UNIT_CREDITS) return "credits";
  if (unit === "requests") return "requests";
  if (unit === "token-units") return "token units";
  if (unit === "user-months") return "seat-months";
  return unit || "units";
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  }).format(value);
}

function count(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

/**
 * Consumption SKUs grouped by unit type, so a credit count and a request count
 * are never rendered in one comparable bar chart. Each unit gets its own
 * section with its own scale.
 */
function groupByUnit(rows: ConsumptionSkuBreakdown[]): { unit: string; rows: ConsumptionSkuBreakdown[] }[] {
  const map = new Map<string, ConsumptionSkuBreakdown[]>();
  for (const r of rows) {
    const list = map.get(r.unit);
    if (list) list.push(r);
    else map.set(r.unit, [r]);
  }
  // Credits first when present; they are the current billing unit.
  return [...map.entries()]
    .map(([unit, unitRows]) => ({ unit, rows: unitRows }))
    .sort((a, b) => {
      if (a.unit === UNIT_CREDITS) return -1;
      if (b.unit === UNIT_CREDITS) return 1;
      return a.unit.localeCompare(b.unit);
    });
}

function SurfaceSection({
  breakdown,
  currency,
  windowLabel,
}: Readonly<{ breakdown: CopilotBillingBreakdown; currency: string; windowLabel: string }>) {
  const groups = groupByUnit(breakdown.consumptionSkus);

  return (
    <Card className="p-6">
      <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
        <Layers className="h-4 w-4" /> AI credits by surface
      </h3>
      <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
        Billed consumption per SKU for {windowLabel}, split into usage covered by the
        entitlement pool and usage charged above it. The split is derived from each row&apos;s
        discount share — GitHub&apos;s report does not state it directly.
      </p>

      {groups.length === 0 ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          No consumption was billed in this window.
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const max = Math.max(1, ...group.rows.map((r) => r.quantity));
            return (
              <div key={group.unit}>
                <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-3">
                  Billed in {unitLabel(group.unit)}
                </p>
                <div className="space-y-4">
                  {group.rows.map((r) => (
                    <div key={`${r.sku}-${r.unit}`}>
                      <div className="flex items-center justify-between text-xs mb-1 gap-3">
                        <span className="font-medium">{r.label}</span>
                        <span className="text-[hsl(var(--muted-foreground))] tabular-nums">
                          {count(r.quantity)} {unitLabel(group.unit)}
                          {group.unit === UNIT_CREDITS && (
                            <> · {count(r.poolQuantity)} pool / {count(r.additionalQuantity)} above</>
                          )}
                          {" · "}
                          {money(r.netCost, currency)}
                        </span>
                      </div>
                      <div className="relative h-3 w-full rounded-full bg-[hsl(var(--accent))] overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/70"
                          style={{ width: `${(r.poolQuantity / max) * 100}%` }}
                        />
                        <div
                          className="absolute inset-y-0 rounded-full bg-amber-500/80"
                          style={{
                            left: `${(r.poolQuantity / max) * 100}%`,
                            width: `${(r.additionalQuantity / max) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <p className="flex items-center gap-3 text-xs text-[hsl(var(--muted-foreground))]">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500/70" aria-hidden="true" />
              Entitlement pool
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500/80" aria-hidden="true" />
              Above pool
            </span>
          </p>
        </div>
      )}
    </Card>
  );
}

function DailySection({
  breakdown,
  currency,
  windowLabel,
}: Readonly<{ breakdown: CopilotBillingBreakdown; currency: string; windowLabel: string }>) {
  const daily = breakdown.daily;
  const max = Math.max(1, ...daily.map((d) => Math.abs(d.totalNet)));

  return (
    <Card className="p-6">
      <h3 className="text-sm font-semibold mb-1">Billed Copilot cost per day</h3>
      <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
        Net charge per day across {windowLabel}, so the period on screen is visibly the
        period being charted.
      </p>
      {daily.length === 0 ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          No billed days in this window.
        </p>
      ) : (
        <div className="flex items-end gap-px h-32" role="img" aria-label="Daily billed Copilot cost">
          {daily.map((d) => (
            <div
              key={d.day}
              className="flex-1 min-w-px rounded-t bg-[hsl(var(--primary))]/70 hover:bg-[hsl(var(--primary))]"
              style={{ height: `${Math.max((Math.abs(d.totalNet) / max) * 100, d.totalNet !== 0 ? 2 : 0)}%` }}
              title={`${d.day}: ${money(d.totalNet, currency)}`}
            />
          ))}
        </div>
      )}
      {daily.length > 0 && (
        <div className="mt-2 flex justify-between text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
          <span>{daily[0].day}</span>
          <span>{daily[daily.length - 1].day}</span>
        </div>
      )}
    </Card>
  );
}

function OrgSection({
  breakdown,
  currency,
  windowLabel,
}: Readonly<{ breakdown: CopilotBillingBreakdown; currency: string; windowLabel: string }>) {
  const orgs = breakdown.orgs.slice(0, 15);
  if (orgs.length === 0) return null;

  return (
    <Card className="p-6">
      <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
        <Building2 className="h-4 w-4" /> Billed cost &amp; consumption by organization
      </h3>
      <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
        What each organization was actually charged in {windowLabel}, from the billing
        report — not seats priced against a configured rate card.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Billed Copilot seat cost, AI credits and consumption charges per organization for the
            selected window and scope.
          </caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Organization</th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Seat-months</th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Seat cost</th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Credits</th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Consumption</th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Total</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.organization || "(enterprise-level)"} className="border-b border-[hsl(var(--border))]/50 hover:bg-[hsl(var(--accent))]/40">
                <td className="px-3 py-2 font-medium">{o.organization || "(enterprise-level)"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{count(o.seatMonths, 1)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(o.seatCostNet, currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{count(o.credits)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(o.consumptionCostNet, currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{money(o.totalNet, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function LicenseBilledBreakdown({
  breakdown,
  currency = "USD",
  windowLabel = "the selected period",
}: Readonly<LicenseBilledBreakdownProps>) {
  if (!breakdown?.hasBilledData) return null;

  const totalNet = breakdown.daily.reduce((sum, d) => sum + safeNum(d.totalNet), 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <SurfaceSection breakdown={breakdown} currency={currency} windowLabel={windowLabel} />
        <DailySection breakdown={breakdown} currency={currency} windowLabel={windowLabel} />
      </div>
      <OrgSection breakdown={breakdown} currency={currency} windowLabel={windowLabel} />
      {breakdown.orgs.length > 15 && (
        <p className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Showing the 15 highest-cost organizations of {breakdown.orgs.length}, totalling{" "}
          {money(totalNet, currency)} across the window.
        </p>
      )}
    </div>
  );
}
