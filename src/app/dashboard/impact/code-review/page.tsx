"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Eye,
  MessageSquare,
  CheckCircle,
  TrendingUp,
  UserCheck,
  Users,
  Shield,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

interface DailyCodeReview {
  day: string;
  totalReviewedByCopilot: number;
  totalSuggestions: number;
  totalAppliedSuggestions: number;
  codeReviewActiveUsers: number;
  codeReviewPassiveUsers: number;
}

interface CodeReviewKPIs {
  totalReviewedByCopilot: number;
  totalSuggestions: number;
  totalAppliedSuggestions: number;
  suggestionAcceptanceRate: number;
  codeReviewActiveUsers: number;
  codeReviewPassiveUsers: number;
}

interface ImpactData {
  days: number;
  start: string;
  end: string;
  codeReviewImpact?: {
    daily: DailyCodeReview[];
    kpis: CodeReviewKPIs;
  };
}

export default function CodeReviewImpactPage() {
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
        <PageHeader
          title="Code Review Impact"
          description="Copilot code review suggestions and acceptance"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
          {Array.from({ length: 6 }).map((_, i) => (
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
        <PageHeader
          title="Code Review Impact"
          description="Copilot code review suggestions and acceptance"
        />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  if (!data.codeReviewImpact) {
    return (
      <div>
        <PageHeader
          title="Code Review Impact"
          description="Copilot code review suggestions and acceptance"
        />
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-[hsl(var(--muted-foreground))]">
          <Shield className="h-10 w-10 opacity-40" />
          <p className="font-medium">
            Code review impact data is not available
          </p>
        </div>
      </div>
    );
  }

  const { kpis, daily } = data.codeReviewImpact;

  return (
    <div>
      <PageHeader
        title="Code Review Impact"
        description="Copilot code review suggestions and acceptance"
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: "Code Review Impact",
            filename: `code-review-impact-${days}d`,
            metadata: {
              reportName: "Code Review Impact",
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8"
      >
        <MetricCard
          title="PRs Reviewed"
          value={kpis.totalReviewedByCopilot}
          icon={<Eye className="h-4 w-4" />}
        />
        <MetricCard
          title="Suggestions"
          value={kpis.totalSuggestions}
          icon={<MessageSquare className="h-4 w-4" />}
        />
        <MetricCard
          title="Applied"
          value={kpis.totalAppliedSuggestions}
          icon={<CheckCircle className="h-4 w-4" />}
        />
        <MetricCard
          title="Acceptance Rate"
          value={kpis.suggestionAcceptanceRate}
          format="percent"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <MetricCard
          title="Active Reviewers"
          value={kpis.codeReviewActiveUsers}
          icon={<UserCheck className="h-4 w-4" />}
          subtitle="Created reviews"
        />
        <MetricCard
          title="Passive Reviewers"
          value={kpis.codeReviewPassiveUsers}
          icon={<Users className="h-4 w-4" />}
          subtitle="Received reviews"
        />
      </div>

      <div ref={chartsRef}>
        <Card>
          <CardHeader>
            <CardTitle>Daily Suggestions vs Applied</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar
                  dataKey="totalSuggestions"
                  name="Suggestions"
                  fill="#3b82f6"
                />
                <Bar
                  dataKey="totalAppliedSuggestions"
                  name="Applied"
                  fill="#10b981"
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
