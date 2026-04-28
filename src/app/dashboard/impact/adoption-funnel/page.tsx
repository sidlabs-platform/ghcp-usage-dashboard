"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Users, UserCheck, Star, Crown } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";

const FUNNEL_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"];

interface ImpactData {
  days: number;
  start: string;
  end: string;
  adoptionFunnel?: {
    totalSeats: number;
    activeUsers: number;
    regularUsers: number;
    powerUsers: number;
  };
}

const PAGE_TITLE = "Adoption Funnel";
const PAGE_DESC =
  "Visualize user progression from seats to power users";

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export default function AdoptionFunnelPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<ImpactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    const scopeParams = buildScopeParams();
    const params = new URLSearchParams({ days: String(days) });
    scopeParams.forEach((v, k) => params.set(k, v));

    fetch(`/api/metrics/impact?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, buildScopeParams]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESC} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50"
            />
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESC} />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const funnel = data.adoptionFunnel;

  if (!funnel) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESC} />
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-[hsl(var(--muted-foreground))]">
          <Users className="h-10 w-10 opacity-40" />
          <div className="text-center">
            <p className="font-medium">Adoption funnel data is not available</p>
            <p className="mt-1 max-w-md">
              Run a sync to generate adoption funnel metrics.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const stages = [
    { name: "Total Seats", value: funnel.totalSeats },
    { name: "Active Users", value: funnel.activeUsers },
    { name: "Regular Users", value: funnel.regularUsers },
    { name: "Power Users", value: funnel.powerUsers },
  ];

  return (
    <div>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESC}>
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: PAGE_TITLE,
            filename: `adoption-funnel-${days}d`,
            metadata: {
              reportName: PAGE_TITLE,
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* KPI Cards */}
      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8"
      >
        <MetricCard
          title="Total Seats"
          value={funnel.totalSeats}
          icon={<Users className="h-4 w-4" />}
          subtitle="Licensed seats"
        />
        <MetricCard
          title="Active Users"
          value={funnel.activeUsers}
          icon={<UserCheck className="h-4 w-4" />}
          subtitle={pct(funnel.activeUsers, funnel.totalSeats) + " of seats"}
        />
        <MetricCard
          title="Regular Users"
          value={funnel.regularUsers}
          icon={<Star className="h-4 w-4" />}
          subtitle="5+ days active"
        />
        <MetricCard
          title="Power Users"
          value={funnel.powerUsers}
          icon={<Crown className="h-4 w-4" />}
          subtitle="3+ features used"
        />
      </div>

      {/* Funnel Chart */}
      <div ref={chartsRef} className="mb-8 rounded-xl border bg-[hsl(var(--card))] p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold">Adoption Funnel</h3>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart
            data={stages}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 100, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" />
            <YAxis type="category" dataKey="name" width={90} />
            <Tooltip
              formatter={(value: number) => [value.toLocaleString(), "Users"]}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]}>
              {stages.map((_, index) => (
                <Cell key={`cell-${index}`} fill={FUNNEL_COLORS[index % FUNNEL_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Conversion Rates */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          title="Active / Total"
          value={pct(funnel.activeUsers, funnel.totalSeats)}
          format="raw"
          icon={<UserCheck className="h-4 w-4" />}
          subtitle="Seat activation rate"
        />
        <MetricCard
          title="Regular / Active"
          value={pct(funnel.regularUsers, funnel.activeUsers)}
          format="raw"
          icon={<Star className="h-4 w-4" />}
          subtitle="Retention rate"
        />
        <MetricCard
          title="Power / Regular"
          value={pct(funnel.powerUsers, funnel.regularUsers)}
          format="raw"
          icon={<Crown className="h-4 w-4" />}
          subtitle="Power user conversion"
        />
      </div>
    </div>
  );
}
