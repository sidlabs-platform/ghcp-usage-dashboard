"use client";

import { useState, useCallback } from "react";
import { Copy, Check, X } from "lucide-react";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { periodLabel } from "@/lib/date/month-range";
import { cn } from "@/lib/utils";

/**
 * The provenance line for every number on the page: which slice of the
 * enterprise, over which dates.
 *
 * This renders unconditionally. Scope lives in context and persists across
 * navigation, so a page that stays silent when unfiltered leaves the reader
 * unable to distinguish "these are enterprise-wide totals" from "I forgot I
 * left a team filter on two pages ago" — a distinction that matters most on
 * the Finance pages, which query scope but historically never surfaced a
 * control for it.
 *
 * Unfiltered is stated quietly. Filtered is conspicuous and removable, because
 * an active filter changes what every figure on the page means.
 */
export function ScopeSummary() {
  const { days, mode, startDate, endDate, period } = useDateRange();
  const {
    hasFilter,
    selectedEnterprises,
    selectedEntTeams,
    selectedOrgTeams,
    selectedOrgs,
    setSelectedEnterprises,
    setSelectedEntTeams,
    setSelectedOrgTeams,
    setSelectedOrgs,
    clearAll,
  } = useScope();

  const [copied, setCopied] = useState(false);

  const handleCopyLink = useCallback(() => {
    if (typeof window === "undefined") return;
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const dateLabel =
    mode === "month" && period
      ? periodLabel(period)
      : mode === "custom" && startDate && endDate
      ? `${startDate} → ${endDate}`
      : `Last ${days} day${days === 1 ? "" : "s"}`;

  const chips: { key: string; label: string; remove: () => void }[] = [
    ...selectedEnterprises.map((v) => ({
      key: `ent:${v}`,
      label: v,
      remove: () => setSelectedEnterprises(selectedEnterprises.filter((x) => x !== v)),
    })),
    ...selectedEntTeams.map((v) => ({
      key: `entteam:${v}`,
      label: v,
      remove: () => setSelectedEntTeams(selectedEntTeams.filter((x) => x !== v)),
    })),
    ...selectedOrgTeams.map((v) => ({
      key: `orgteam:${v}`,
      label: v,
      remove: () => setSelectedOrgTeams(selectedOrgTeams.filter((x) => x !== v)),
    })),
    ...selectedOrgs.map((v) => ({
      key: `org:${v}`,
      label: v,
      remove: () => setSelectedOrgs(selectedOrgs.filter((x) => x !== v)),
    })),
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs"
      // Scope and date changes silently rewrite every figure below. Announce
      // the new basis so it isn't a visual-only update.
      aria-live="polite"
    >
      <span className="text-[hsl(var(--muted-foreground))]">
        {dateLabel}
        <span aria-hidden="true" className="mx-2 opacity-40">
          ·
        </span>
      </span>

      {!hasFilter ? (
        <span className="text-[hsl(var(--muted-foreground))]">All enterprises</span>
      ) : (
        <>
          <span className="font-medium text-[hsl(var(--foreground))]">Filtered to</span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full border border-[hsl(var(--primary))]/30 bg-[hsl(var(--primary))]/10 py-0.5 pl-2 pr-1 font-medium text-[hsl(var(--primary))]"
            >
              {chip.label}
              <button
                type="button"
                onClick={chip.remove}
                aria-label={`Remove ${chip.label} from scope`}
                className="rounded-full p-0.5 transition-colors hover:bg-[hsl(var(--primary))]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="rounded px-1.5 py-0.5 font-medium text-[hsl(var(--muted-foreground))] underline-offset-2 transition-colors hover:text-[hsl(var(--foreground))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          >
            Clear
          </button>
        </>
      )}

      {/* Copy link — surfaces the URL so a filtered view is shareable. */}
      <button
        type="button"
        onClick={handleCopyLink}
        aria-label={copied ? "Link copied" : "Copy link to this view"}
        title={copied ? "Copied!" : "Copy link to this view"}
        className={cn(
          "ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
          copied
            ? "text-[hsl(var(--primary))]"
            : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]",
        )}
      >
        {copied ? (
          <Check aria-hidden="true" className="h-3 w-3" />
        ) : (
          <Copy aria-hidden="true" className="h-3 w-3" />
        )}
        <span className="sr-only">{copied ? "Copied" : "Copy link"}</span>
      </button>
    </div>
  );
}
