"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Wallet } from "lucide-react";
import {
  MAX_ANNUAL_SALARY,
  SALARY_BANDS,
  normalizeSalary,
} from "@/lib/roi/salary";

interface SalarySelectorProps {
  value: number;
  onChange: (value: number) => void;
  /** ISO currency code used for band formatting. */
  currency: string;
}

function formatBand(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Unknown/invalid ISO code — fall back to a plain compact number.
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 0,
    }).format(amount);
  }
}

/**
 * Compensation-band picker driving the "% Payroll/month" ROI metric.
 * Purely a modeling input — the value never leaves the browser.
 */
export function SalarySelector({ value, onChange, currency }: SalarySelectorProps) {
  const isCustom = !SALARY_BANDS.includes(value as (typeof SALARY_BANDS)[number]);
  const [showCustom, setShowCustom] = useState(isCustom);
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  const applyCustom = () => {
    const normalized = normalizeSalary(draft);
    if (normalized === null) {
      setError(`Enter an amount between 1 and ${MAX_ANNUAL_SALARY.toLocaleString()}.`);
      return;
    }
    setError(null);
    onChange(normalized);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))]">
        <Wallet className="h-3.5 w-3.5" />
        Avg developer salary
      </span>

      <div className="flex items-center rounded-lg bg-[hsl(var(--muted))] p-1">
        {SALARY_BANDS.map((band) => (
          <button
            key={band}
            type="button"
            onClick={() => {
              setShowCustom(false);
              setError(null);
              onChange(band);
            }}
            aria-pressed={!showCustom && value === band}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
              !showCustom && value === band
                ? "bg-[hsl(var(--background))] text-[hsl(var(--foreground))] shadow-sm"
                : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]",
            )}
          >
            {formatBand(band, currency)}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          setDraft(String(value));
          setError(null);
          setShowCustom((s) => !s);
        }}
        aria-pressed={showCustom}
        className={cn(
          "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
          showCustom
            ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]"
            : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:border-[hsl(var(--foreground)/0.3)]",
        )}
      >
        Custom
      </button>

      {showCustom && (
        <div className="flex items-center gap-2">
          <label htmlFor="roi-custom-salary" className="sr-only">
            Custom annual salary
          </label>
          <input
            id="roi-custom-salary"
            type="number"
            min={1}
            max={MAX_ANNUAL_SALARY}
            step={1000}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyCustom();
            }}
            className="w-32 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          />
          <button
            type="button"
            onClick={applyCustom}
            className="rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          >
            Apply
          </button>
        </div>
      )}

      {error && (
        <span role="alert" className="text-xs text-[hsl(var(--destructive))]">
          {error}
        </span>
      )}
    </div>
  );
}
