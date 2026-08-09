"use client";

// Query-state controls for the historical License & AI Credits reconciliation
// dashboard: temporal scope display, explicit billing-period override list,
// detail/rollup view toggle, search, and the enum filters accepted by
// `/api/billing/license-reconciliation` (see `route.ts`'s PLAN_TYPES /
// ACCOUNT_STATES / SEAT_STATUSES / HISTORY_CONFIDENCE_LEVELS allowlists,
// mirrored below as the client-side option lists). All state is owned by the
// parent page — this component is fully controlled.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";

/** Mirrors `PLAN_TYPES` in `src/app/api/billing/license-reconciliation/route.ts`. */
export const PLAN_TYPE_OPTIONS = ["business", "enterprise", "unknown"] as const;
/** Mirrors `ACCOUNT_STATES` in `src/app/api/billing/license-reconciliation/route.ts`. */
export const ACCOUNT_STATE_OPTIONS = ["unknown", "member", "suspended", "deprovisioned"] as const;
/** Mirrors `SEAT_STATUSES` in `src/app/api/billing/license-reconciliation/route.ts`. */
export const SEAT_STATUS_OPTIONS = ["active", "inactive", "no_seat"] as const;
/** Mirrors `HISTORY_CONFIDENCE_LEVELS` in `src/app/api/billing/license-reconciliation/route.ts`. */
export const HISTORY_CONFIDENCE_OPTIONS = [
  "exact_snapshot",
  "audit_reconstructed",
  "live_snapshot_only",
  "unrecoverable",
] as const;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface LicensePeriodFiltersProps {
  view: "detail" | "rollup";
  onViewChange: (view: "detail" | "rollup") => void;
  /** Explicit "YYYY-MM" periods; when non-empty these override the date-range-derived periods server-side. */
  periods: string[];
  onPeriodsChange: (periods: string[]) => void;
  search: string;
  onSearchChange: (value: string) => void;
  planTypes: string[];
  onPlanTypesChange: (values: string[]) => void;
  accountStates: string[];
  onAccountStatesChange: (values: string[]) => void;
  seatStatuses: string[];
  onSeatStatusesChange: (values: string[]) => void;
  historyConfidence: string[];
  onHistoryConfidenceChange: (values: string[]) => void;
  onClearFilters: () => void;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

interface FilterGroupProps {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (values: string[]) => void;
}

function FilterGroup({ label, options, selected, onChange }: FilterGroupProps) {
  return (
    <div role="group" aria-label={label} className="space-y-1.5">
      <span className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onChange(toggleValue(selected, option))}
              className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                isSelected
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]"
                  : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LicensePeriodFilters({
  view,
  onViewChange,
  periods,
  onPeriodsChange,
  search,
  onSearchChange,
  planTypes,
  onPlanTypesChange,
  accountStates,
  onAccountStatesChange,
  seatStatuses,
  onSeatStatusesChange,
  historyConfidence,
  onHistoryConfidenceChange,
  onClearFilters,
}: LicensePeriodFiltersProps) {
  const { mode, days, startDate, endDate } = useDateRange();
  const { hasFilter, selectedEntTeams, selectedOrgTeams, selectedOrgs } = useScope();
  const [monthDraft, setMonthDraft] = useState("");
  const [searchDraft, setSearchDraft] = useState(search);

  const scopeLabels = [...selectedEntTeams, ...selectedOrgTeams, ...selectedOrgs];

  useEffect(() => {
    setSearchDraft(search);
  }, [search]);

  const handleAddPeriod = () => {
    const trimmed = monthDraft.trim();
    if (!MONTH_RE.test(trimmed)) return;
    const next = Array.from(new Set([...periods, trimmed])).sort();
    onPeriodsChange(next);
    setMonthDraft("");
  };

  const handleRemovePeriod = (period: string) => {
    onPeriodsChange(periods.filter((p) => p !== period));
  };

  const commitSearch = () => {
    const nextSearch = searchDraft.trim();
    if (nextSearch !== search) onSearchChange(nextSearch);
  };

  const sortedPeriods = [...periods].sort();

  return (
    <div className="space-y-4 rounded-lg border p-4">
      {/* Temporal scope + view */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[hsl(var(--muted-foreground))]">
          {mode === "custom" ? (
            <span>
              Custom range: <span className="tabular-nums font-medium text-[hsl(var(--foreground))]">{startDate}</span>{" "}
              – <span className="tabular-nums font-medium text-[hsl(var(--foreground))]">{endDate}</span>
            </span>
          ) : (
            <span>
              Preset range: <span className="font-medium text-[hsl(var(--foreground))]">Last {days} days</span>
            </span>
          )}
          {sortedPeriods.length > 0 && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">
              Explicit periods override the date range above.
            </span>
          )}
        </div>

        <div role="group" aria-label="Row grain" className="inline-flex rounded-md border p-0.5">
          <button
            type="button"
            aria-pressed={view === "detail"}
            onClick={() => onViewChange("detail")}
            className={`rounded px-3 py-1 text-xs font-medium ${
              view === "detail" ? "bg-[hsl(var(--accent))]" : "text-[hsl(var(--muted-foreground))]"
            }`}
          >
            Detail
          </button>
          <button
            type="button"
            aria-pressed={view === "rollup"}
            onClick={() => onViewChange("rollup")}
            className={`rounded px-3 py-1 text-xs font-medium ${
              view === "rollup" ? "bg-[hsl(var(--accent))]" : "text-[hsl(var(--muted-foreground))]"
            }`}
          >
            Rollup
          </button>
        </div>
      </div>

      {/* Explicit period override */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="license-period-add" className="mb-1 block text-xs font-medium text-[hsl(var(--muted-foreground))]">
            Add billing period
          </label>
          <input
            id="license-period-add"
            type="month"
            value={monthDraft}
            onChange={(e) => setMonthDraft(e.target.value)}
            aria-label="Add billing period"
            className="rounded-md border bg-[hsl(var(--background))] px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={handleAddPeriod}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-[hsl(var(--accent))]"
        >
          Add
        </button>
        {sortedPeriods.length > 0 && (
          <button
            type="button"
            onClick={() => onPeriodsChange([])}
            aria-label="Clear periods"
            className="rounded-md border px-3 py-1.5 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
          >
            Clear periods
          </button>
        )}
        <div className="flex flex-wrap gap-1.5">
          {sortedPeriods.map((period) => (
            <span
              key={period}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums"
            >
              <span>{period}</span>
              <button
                type="button"
                aria-label={`Remove ${period}`}
                onClick={() => handleRemovePeriod(period)}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Search */}
      <div>
        <label htmlFor="license-search" className="mb-1 block text-xs font-medium text-[hsl(var(--muted-foreground))]">
          Search users or organizations
        </label>
        <input
          id="license-search"
          type="text"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onBlur={commitSearch}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitSearch();
          }}
          aria-label="Search users or organizations"
          placeholder="login, org…"
          className="w-64 rounded-md border bg-[hsl(var(--background))] px-3 py-1.5 text-sm"
        />
      </div>

      {/* Enum filters */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterGroup label="Plan" options={PLAN_TYPE_OPTIONS} selected={planTypes} onChange={onPlanTypesChange} />
        <FilterGroup
          label="Account state"
          options={ACCOUNT_STATE_OPTIONS}
          selected={accountStates}
          onChange={onAccountStatesChange}
        />
        <FilterGroup
          label="Seat status"
          options={SEAT_STATUS_OPTIONS}
          selected={seatStatuses}
          onChange={onSeatStatusesChange}
        />
        <FilterGroup
          label="History confidence"
          options={HISTORY_CONFIDENCE_OPTIONS}
          selected={historyConfidence}
          onChange={onHistoryConfidenceChange}
        />
      </div>

      {/* Scope status (read-only) + clear */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-[hsl(var(--muted-foreground))]">
        <span>
          {hasFilter ? (
            <>Scope filtered to: <span className="font-medium text-[hsl(var(--foreground))]">{scopeLabels.join(", ")}</span></>
          ) : (
            "No scope filter applied."
          )}
        </span>
        <button
          type="button"
          onClick={onClearFilters}
          aria-label="Clear filters"
          className="rounded-md border px-3 py-1 font-medium hover:bg-[hsl(var(--accent))]"
        >
          Clear filters
        </button>
      </div>
    </div>
  );
}
