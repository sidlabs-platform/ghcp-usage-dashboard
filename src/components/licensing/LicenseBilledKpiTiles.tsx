"use client";

// Period-scoped KPI tiles for the License & AI Credits Overview tab.
//
// Every figure here is read from the billed rows in `billing_usage_records`
// over the *selected* window, via `getCopilotBillingBreakdown()` and
// `getCopilotCostBasis()`. Nothing on this surface may come from
// `copilot_seats` (an undated snapshot describing today's roster) or from
// `dashboard-config.json` list prices and notional allowances (operator
// -entered, identical in every period). Those sources are why the previous
// tiles did not move when the month changed.
//
// Two consequences of that rule show up in the rendering:
//
//  1. A tile appears only when the unit behind it was actually billed in the
//     window. A pre-June-2026 month shows premium requests; a month after the
//     cutover shows AI credits. Quantities are never summed across units.
//  2. The entitlement-pool split is labelled as *derived*. GitHub's AI-credit
//     report carries no `exceeds_quota` column, so the split is inferred from
//     `discount_amount / gross_amount`.

import { MetricCard } from "@/components/cards/MetricCard";
import { Users, CreditCard, Wallet, Zap, PiggyBank, TrendingUp, Info } from "lucide-react";
import { safeNum } from "@/lib/utils";
import type { CopilotBillingBreakdown, CopilotCostBasis } from "@/lib/types/billing";

export interface LicenseBilledKpiTilesProps {
  basis: CopilotCostBasis | null;
  breakdown: CopilotBillingBreakdown | null;
  currency?: string;
  /** Human name for the selected window, so every figure states its own scope. */
  windowLabel?: string;
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

export function LicenseBilledKpiTiles({
  basis,
  breakdown,
  currency = "USD",
  windowLabel = "the selected period",
}: Readonly<LicenseBilledKpiTilesProps>) {
  const seatSkus = breakdown?.seatSkus ?? [];
  const consumptionSkus = breakdown?.consumptionSkus ?? [];
  const hasBilledData = !!breakdown?.hasBilledData;

  if (!hasBilledData) {
    return (
      <div
        role="note"
        className="flex items-start gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 px-4 py-4 text-sm"
      >
        <Info className="h-5 w-5 shrink-0 mt-0.5 text-[hsl(var(--muted-foreground))]" />
        <div>
          <p className="font-medium">No Copilot billing rows for {windowLabel}.</p>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            These tiles are built only from what GitHub actually billed in this period, so there is
            nothing to show rather than a set of zeroes. Select a period the billing sync has
            covered, or run a billing sync to populate it.
          </p>
        </div>
      </div>
    );
  }

  const seatUsers = safeNum(basis?.seatUsers ?? 0);
  const seatCensusComplete = !!basis?.seatPopulationComplete;
  const seatMonths = safeNum(basis?.seatQuantity ?? 0);
  const seatCostNet = safeNum(basis?.seatCostNet ?? 0);
  const consumptionCostNet = safeNum(basis?.creditCostNet ?? 0);
  const totalNet = safeNum(basis?.totalCopilotNet ?? seatCostNet + consumptionCostNet);

  const creditsBilled = safeNum(basis?.creditsBilled ?? 0);
  const requestsBilled = safeNum(basis?.requestsBilled ?? 0);
  const tokenUnitsBilled = safeNum(basis?.tokenUnitsBilled ?? 0);

  const poolCredits = safeNum(breakdown?.poolCredits ?? 0);
  const additionalCredits = safeNum(breakdown?.additionalCredits ?? 0);
  const additionalCreditCostNet = safeNum(breakdown?.additionalCreditCostNet ?? 0);
  const splitBase = poolCredits + additionalCredits;
  const poolPct = splitBase > 0 ? (poolCredits / splitBase) * 100 : null;

  // A billed seat count is only a headcount when GitHub named users on
  // essentially every billed seat. Where it did not, seat-months — a duration
  // — is the only figure the report actually supports, so lead with that
  // rather than headline a half-covered census as if it were complete.
  const licensedTile = seatCensusComplete && seatUsers > 0
    ? {
        title: "Licensed users (billed)",
        value: count(seatUsers),
        subtitle: `${count(seatMonths, 1)} seat-months · ${count(safeNum(basis?.seatAssignments ?? 0))} seat assignments`,
      }
    : {
        title: "Billed seat-months",
        value: count(seatMonths, 1),
        subtitle:
          seatUsers > 0
            ? `${count(seatUsers)} users named on part of this period's seats — not a full census`
            : "GitHub reported this period's seats without usernames",
      };

  const licenceTiles = seatSkus.map((s) => ({
    key: `seat-${s.sku || "unspecified"}`,
    title: s.label,
    value: count(s.seatMonths, 1),
    subtitle:
      s.users > 0
        ? `${count(s.users)} users · ${money(s.netCost, currency)} billed`
        : `${money(s.netCost, currency)} billed · seat-months`,
  }));

  const showCredits = creditsBilled > 0 || splitBase > 0;
  const showRequests = requestsBilled > 0;
  const showTokenUnits = tokenUnitsBilled > 0;

  const perUserDivisor = seatCensusComplete && seatUsers > 0 ? seatUsers : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title={licensedTile.title}
          value={licensedTile.value}
          format="raw"
          accent="blue"
          icon={<Users className="h-5 w-5" />}
          subtitle={licensedTile.subtitle}
        />
        {licenceTiles.map((t) => (
          <MetricCard
            key={t.key}
            title={t.title}
            value={t.value}
            format="raw"
            accent="violet"
            icon={<CreditCard className="h-5 w-5" />}
            subtitle={t.subtitle}
          />
        ))}
        <MetricCard
          title="Seat cost (billed)"
          value={money(seatCostNet, currency)}
          format="raw"
          accent="teal"
          icon={<CreditCard className="h-5 w-5" />}
          subtitle="Net charged for Copilot seats"
        />
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {showCredits && (
          <>
            <MetricCard
              title="Entitlement pool credits"
              value={count(poolCredits)}
              format="raw"
              accent="green"
              icon={<PiggyBank className="h-5 w-5" />}
              subtitle={
                poolPct !== null
                  ? `${poolPct.toFixed(0)}% of billed credits · derived from discounts`
                  : "Covered by the included allowance"
              }
            />
            <MetricCard
              title="Usage above entitlement pool"
              value={count(additionalCredits)}
              format="raw"
              accent="amber"
              icon={<Zap className="h-5 w-5" />}
              subtitle={`${money(additionalCreditCostNet, currency)} charged beyond the pool`}
            />
          </>
        )}
        {showRequests && (
          <MetricCard
            title="Premium requests"
            value={count(requestsBilled)}
            format="raw"
            accent="violet"
            icon={<Zap className="h-5 w-5" />}
            subtitle="Billed as requests, never added to credits"
          />
        )}
        {showTokenUnits && (
          <MetricCard
            title="Token units"
            value={count(tokenUnitsBilled)}
            format="raw"
            accent="violet"
            icon={<Zap className="h-5 w-5" />}
            subtitle="Billed separately from credits"
          />
        )}
        <MetricCard
          title="Consumption charges"
          value={money(consumptionCostNet, currency)}
          format="raw"
          accent="amber"
          icon={<Zap className="h-5 w-5" />}
          subtitle={
            consumptionCostNet === 0 ? "Fully within pooled allowance" : "Charged beyond allowance"
          }
        />
        <MetricCard
          title="Total Copilot cost"
          value={money(totalNet, currency)}
          format="raw"
          accent="green"
          icon={<Wallet className="h-5 w-5" />}
          subtitle="Seats + consumption charges"
        />
      </div>

      {perUserDivisor > 0 && (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Cost per licensed user"
            value={money(totalNet / perUserDivisor, currency)}
            format="raw"
            accent="teal"
            icon={<TrendingUp className="h-5 w-5" />}
            subtitle={`Across ${count(perUserDivisor)} billed users`}
          />
          {showCredits && (
            <MetricCard
              title="Credits per licensed user"
              value={count(creditsBilled / perUserDivisor, 1)}
              format="raw"
              accent="violet"
              icon={<TrendingUp className="h-5 w-5" />}
              subtitle={`${count(creditsBilled)} credits across ${count(perUserDivisor)} billed users`}
            />
          )}
        </div>
      )}

      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        Every figure above is billed usage for {windowLabel}. The entitlement-pool split is
        derived from each row&apos;s discount share, since GitHub&apos;s AI-credit report does not
        report it directly.
        {consumptionSkus.length > 0 &&
          " Per-surface detail is broken out below."}
      </p>
    </div>
  );
}
