"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CreditCard, UserCheck, UserX, Percent, AlertCircle } from "lucide-react";
import { formatNumber } from "@/lib/utils";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

interface LicenseUtilizationDaily {
  day: string;
  activeUsers: number;
  totalUsers: number;
}

interface LicenseUtilizationKpis {
  totalSeats: number;
  activeLast30d: number;
  inactiveSeats: number;
  pendingCancellation: number;
  utilizationPercent: number;
}

interface ImpactData {
  days: number;
  start: string;
  end: string;
  licenseUtilization?: {
    kpis: LicenseUtilizationKpis;
    daily: LicenseUtilizationDaily[];
  };
}

const PAGE_TITLE = "License Utilization";
const PAGE_DESCRIPTION =
  "Seat allocation, active usage, and license efficiency over time";

export default function LicenseUtilizationPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<ImpactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
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
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 mb-8">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  if (!data.licenseUtilization) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="flex h-64 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          License utilization data is not available
        </div>
      </div>
    );
  }

  const { kpis, daily } = data.licenseUtilization;

  return (
    <div>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: PAGE_TITLE,
            filename: `license-utilization-report-${days}d`,
            metadata: {
              reportName: PAGE_TITLE,
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 mb-8"
      >
        <MetricCard
          title="Total Seats"
          value={kpis.totalSeats}
          icon={<CreditCard className="h-4 w-4" />}
        />
        <MetricCard
          title="Active (30d)"
          value={kpis.activeLast30d}
          icon={<UserCheck className="h-4 w-4" />}
        />
        <MetricCard
          title="Inactive"
          value={kpis.inactiveSeats}
          icon={<UserX className="h-4 w-4" />}
        />
        <MetricCard
          title="Utilization"
          value={kpis.utilizationPercent}
          format="percent"
          icon={<Percent className="h-4 w-4" />}
        />
        <MetricCard
          title="Pending Cancellation"
          value={kpis.pendingCancellation}
          icon={<AlertCircle className="h-4 w-4" />}
        />
      </div>

      <div ref={chartsRef}>
        <Card>
          <CardHeader>
            <CardTitle>Daily Active vs Total Users</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={380}>
              <AreaChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  label={{
                    value: "Users",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 12 },
                  }}
                />
                <Tooltip />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="totalUsers"
                  name="Total Users"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.1}
                />
                <Area
                  type="monotone"
                  dataKey="activeUsers"
                  name="Active Users"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.3}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
