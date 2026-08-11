"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/ui/Section";
import { SalarySelector } from "@/components/filters/SalarySelector";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ANNUAL_SALARY,
  payrollPercent,
  readStoredSalary,
  writeStoredSalary,
} from "@/lib/roi/salary";
import type { RoiGroup, RoiResponse } from "@/lib/types/metrics";
import { Bot, GitMerge, MessageSquareCode, PiggyBank, Percent } from "lucide-react";

interface RoiSectionProps {
  data: RoiResponse;
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 100 ? 2 : 0,
    }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

const GROUP_META: Record<string, { icon: typeof Bot; accent: string; blurb: string }> = {
  early: {
    icon: MessageSquareCode,
    accent: "border-l-blue-500",
    blurb: "Passive users + Phase 1 — working mainly in chat and code completions",
  },
  agent: {
    icon: Bot,
    accent: "border-l-violet-500",
    blurb: "Phase 2 + Phase 3 — agent-first developers across GitHub surfaces",
  },
};

const COST_SOURCE_LABEL: Record<RoiResponse["costSource"], string> = {
  billing: "Billed AI Credit spend",
  credits: "Estimated from AI credit consumption",
  none: "No cost data",
};

/** The cost half of the caveat depends on where the dollars actually came from. */
const COST_CAVEAT: Record<RoiResponse["costSource"], string> = {
  billing:
    "Cost figures come from billed AI Credit spend attributed per developer, so they reflect actual charges rather than an estimate.",
  credits:
    "Cost figures are estimated from AI credit consumption rather than billed spend, so treat them as directional.",
  none: "Cost figures are unavailable for this selection, so cost and payroll metrics are not shown.",
};

interface StatProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  hint?: string;
}

function Stat({ label, value, icon, hint }: StatProps) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))]">
        {icon}
        {label}
      </div>
      <p className="mt-1 tabular-nums text-2xl font-bold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">{hint}</p>}
    </div>
  );
}

function GroupCard({
  group,
  salary,
  currency,
  hasPrData,
  hasCost,
}: {
  group: RoiGroup;
  salary: number;
  currency: string;
  hasPrData: boolean;
  hasCost: boolean;
}) {
  const meta = GROUP_META[group.key];
  const Icon = meta?.icon ?? Bot;
  const pct = payrollPercent(group.costPerDevPerMonth, salary);

  return (
    <div
      className={cn(
        "rounded-xl border border-l-[3px] bg-[hsl(var(--card))] p-6",
        meta?.accent ?? "border-l-blue-500",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{group.label}</h3>
          <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">{meta?.blurb}</p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]">
          <Icon className="h-4 w-4" />
        </div>
      </div>

      <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
        {group.developers.toLocaleString()} developer{group.developers === 1 ? "" : "s"}
      </p>

      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Stat
          label="Cost/dev/month"
          value={hasCost ? formatCurrency(group.costPerDevPerMonth, currency) : "—"}
          icon={<PiggyBank className="h-3.5 w-3.5" />}
        />
        <Stat
          label="% Payroll/month"
          value={hasCost && pct !== null ? `${pct.toFixed(2)}%` : "—"}
          icon={<Percent className="h-3.5 w-3.5" />}
        />
        <Stat
          label="PRs/dev/month"
          value={hasPrData ? group.prsMergedPerDevPerMonth.toFixed(1) : "—"}
          icon={<GitMerge className="h-3.5 w-3.5" />}
          hint={hasPrData ? `${group.prsMerged.toLocaleString()} merged total` : undefined}
        />
      </div>
    </div>
  );
}

/**
 * "Potential return on investment" — compares Copilot spend against pull-request
 * output for early-phase versus agent-first developers, modeled against a
 * selectable compensation band.
 */
export function RoiSection({ data }: RoiSectionProps) {
  const [salary, setSalary] = useState(DEFAULT_ANNUAL_SALARY);

  // Read after mount so server and client render the same initial markup.
  useEffect(() => {
    setSalary(readStoredSalary());
  }, []);

  const handleSalaryChange = (value: number) => {
    setSalary(value);
    writeStoredSalary(value);
  };

  const early = data.groups.find((g) => g.key === "early");
  const agent = data.groups.find((g) => g.key === "agent");
  const hasCost = data.costSource !== "none";

  // Headline comparison: how much more delivery the agent-first cohort shows
  // per developer, and what the extra spend to get there looks like.
  const prLift =
    data.hasPrData && early && agent && early.prsMergedPerDevPerMonth > 0
      ? ((agent.prsMergedPerDevPerMonth - early.prsMergedPerDevPerMonth) /
          early.prsMergedPerDevPerMonth) *
        100
      : null;
  const costDelta =
    hasCost && early && agent ? agent.costPerDevPerMonth - early.costPerDevPerMonth : null;

  return (
    <Section
      title="Potential Return on Investment"
      description="Copilot spend set against pull request output, split by how deeply developers have adopted Copilot."
      className="mt-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SalarySelector value={salary} onChange={handleSalaryChange} currency={data.currency} />
        <span className="rounded-full bg-[hsl(var(--muted))] px-2.5 py-1 text-xs text-[hsl(var(--muted-foreground))]">
          {COST_SOURCE_LABEL[data.costSource]}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.groups.map((group) => (
          <GroupCard
            key={group.key}
            group={group}
            salary={salary}
            currency={data.currency}
            hasPrData={data.hasPrData}
            hasCost={hasCost}
          />
        ))}
      </div>

      {(prLift !== null || costDelta !== null) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-[hsl(var(--card))] px-4 py-3 text-sm">
          {prLift !== null && (
            <span>
              Agent-first developers merge{" "}
              <strong
                className={cn(
                  "tabular-nums",
                  prLift >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                )}
              >
                {prLift >= 0 ? "+" : ""}
                {prLift.toFixed(0)}%
              </strong>{" "}
              more pull requests per developer.
            </span>
          )}
          {costDelta !== null && (
            <span>
              At{" "}
              <strong className="tabular-nums">
                {costDelta >= 0 ? "+" : "−"}
                {formatCurrency(Math.abs(costDelta), data.currency)}
              </strong>{" "}
              per developer per month.
            </span>
          )}
        </div>
      )}

      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        {COST_CAVEAT[data.costSource]} The salary band is a modeling input rather than actual
        payroll data. Developer counts come from user-level metrics while merged pull requests
        come from the enterprise rollup, so the two populations can differ slightly.
      </p>
    </Section>
  );
}
