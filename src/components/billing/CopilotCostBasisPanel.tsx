"use client";

import { AlertTriangle, Check } from "lucide-react";
import { periodLabel } from "@/lib/date/month-range";
import type { CopilotCostBasis } from "@/lib/types/billing";

/**
 * Re-export the shared billing type so existing page imports stay stable
 * without coupling this client component to the server-only repository module.
 */
export type { CopilotCostBasis };

interface Props {
  basis: CopilotCostBasis | null;
  currency?: string;
  /** Which page is rendering, so the cross-reference points the other way. */
  surface: "billing" | "licensing";
  className?: string;
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function count(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * The reconciliation strip shared by Billing and License & AI Credits.
 *
 * Both pages render this from the *same* API field computed by the *same*
 * query over the *same* window, so the figures agree by construction. That
 * matters more than it sounds: these two pages previously disagreed by up to
 * 60% on AI credits, because one read the complete detailed billing report and
 * the other read the per-user ai_credit report, which GitHub only serves for a
 * short recent window. Showing both numbers together — with the coverage gap
 * named rather than hidden — is the only honest way to present them.
 */
export function CopilotCostBasisPanel({ basis, currency = "USD", surface, className = "" }: Props) {
  if (!basis) return null;

  const windowLabel = basis.period
    ? periodLabel(basis.period)
    : `${basis.startDate} → ${basis.endDate}`;

  const other = surface === "billing" ? "License & AI Credits" : "Billing";
  const otherHref = surface === "billing" ? "/dashboard/license-reconciliation" : "/dashboard/billing";

  const coverage = basis.attributionCoveragePct;
  const showGap = coverage !== null && !basis.attributionComplete;

  // Quantities are only comparable within one unit type. A window billed in
  // premium requests (pre-June-2026) has no credits at all, and reporting its
  // request count under an "AI credits" label — or worse, adding the two — is
  // how this strip previously produced figures no GitHub report could confirm.
  const billedInRequests = basis.creditsBilled <= 0 && basis.requestsBilled > 0;
  const consumption = billedInRequests
    ? { label: "Premium requests consumed", value: count(basis.requestsBilled) }
    : { label: "AI credits consumed", value: count(basis.creditsBilled) };

  const figures: { label: string; value: string; hint: string }[] = [
    {
      label: "Copilot seat licences",
      value: money(basis.seatCostNet, currency),
      hint: `${count(basis.seatQuantity)} billed seat-months`,
    },
    {
      label: consumption.label,
      value: consumption.value,
      hint: basis.tokenUnitsBilled > 0
        ? `Plus ${count(basis.tokenUnitsBilled)} token units, billed separately`
        : "From the detailed billing report",
    },
    {
      label: "Consumption charges",
      value: money(basis.creditCostNet, currency),
      hint: basis.creditCostNet === 0 ? "Fully within pooled allowance" : "Charged beyond allowance",
    },
    {
      label: "Total Copilot cost",
      value: money(basis.totalCopilotNet, currency),
      hint: "Seats + consumption charges",
    },
  ];

  return (
    <section
      aria-labelledby="cost-basis-heading"
      className={`rounded-xl border bg-[hsl(var(--card))] p-5 ${className}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="cost-basis-heading" className="text-base font-semibold">
          Copilot cost basis
        </h3>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          <span className="font-medium tabular-nums">{windowLabel}</span>
          {" · matches "}
          <a
            href={otherHref}
            className="underline underline-offset-2 hover:text-[hsl(var(--foreground))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))]"
          >
            {other}
          </a>
        </p>
      </div>

      <dl className="mt-4 grid gap-4 grid-cols-2 lg:grid-cols-4">
        {figures.map((f) => (
          <div key={f.label}>
            <dt className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{f.label}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums">{f.value}</dd>
            <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">{f.hint}</p>
          </div>
        ))}
      </dl>

      {showGap ? (
        <p
          role="status"
          className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Per-user attribution covers{" "}
            <span className="font-semibold tabular-nums">{coverage.toFixed(0)}%</span> of billed credits
            {" ("}
            <span className="tabular-nums">{count(basis.creditsAttributed)}</span> of{" "}
            <span className="tabular-nums">{count(basis.creditsBilled)}</span> across{" "}
            {count(basis.attributedUsers)} users). GitHub&apos;s per-user AI-credit report only covers a
            recent window, so per-user tables are a partial view of this period — the totals above are
            complete.
            {basis.creditsUnattributed > 0 && (
              <>
                {" "}A further{" "}
                <span className="tabular-nums">{count(basis.creditsUnattributed)}</span> credits are
                reported with no username (org- or enterprise-scoped charges) and cannot appear in any
                per-user table.
              </>
            )}
          </span>
        </p>
      ) : coverage !== null ? (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]"
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          Per-user attribution accounts for all {count(basis.creditsBilled)} billed credits across{" "}
          {count(basis.attributedUsers)} users.
        </p>
      ) : billedInRequests ? (
        <p
          role="status"
          className="mt-4 flex items-start gap-2 text-xs text-[hsl(var(--muted-foreground))]"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            This period was billed in premium requests, before AI credits began on 2026-06-01.
            Per-user AI-credit figures are zero for it by definition — a request is not a credit, so
            the two are never added together.
          </span>
        </p>
      ) : null}
    </section>
  );
}
