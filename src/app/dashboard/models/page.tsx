"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

const ModelUsageBarChart = dynamic(
  () => import("@/components/charts/ModelUsageBarChart").then(m => ({ default: m.ModelUsageBarChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const ModelTrendChart = dynamic(
  () => import("@/components/charts/ModelTrendChart").then(m => ({ default: m.ModelTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const ModelFeatureTable = dynamic(
  () => import("@/components/charts/ModelFeatureTable").then(m => ({ default: m.ModelFeatureTable })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
import { Brain, Hash, Trophy, Percent } from "lucide-react";
import type { ModelStatsResponse } from "@/app/api/metrics/models/route";

export default function ModelsPage() {
  const { days } = useDateRange();
  const [data, setData] = useState<ModelStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/metrics/models?days=${days}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<ModelStatsResponse>;
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days]);

  if (loading) {
    return (
      <div>
        <PageHeader title="Model Statistics" description="AI model usage across your enterprise" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="Model Statistics" description="AI model usage across your enterprise" />
        <div className="flex h-64 items-center justify-center rounded-xl border bg-[hsl(var(--card))] text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const { kpis, modelBreakdown, modelByFeature, modelTrend, modelByLanguage } = data;
  const topModels = modelBreakdown.slice(0, 8).map((m) => m.model);

  // Top languages per model (top 3 models, top 5 languages each)
  const topModelNames = modelBreakdown.slice(0, 5).map((m) => m.model);
  const topLangByModel = topModelNames.map((model) => ({
    model,
    languages: modelByLanguage
      .filter((ml) => ml.model === model)
      .slice(0, 5),
  })).filter((m) => m.languages.length > 0);

  return (
    <div>
      <PageHeader
        title="Model Statistics"
        description="AI model usage, trends, and feature breakdown across your enterprise"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="Models Used"
          value={kpis.totalModels}
          icon={<Brain className="h-4 w-4" />}
          subtitle="Distinct models in period"
        />
        <MetricCard
          title="Total Interactions"
          value={kpis.totalInteractions}
          icon={<Hash className="h-4 w-4" />}
          subtitle="Model-attributed interactions"
        />
        <MetricCard
          title="Top Model"
          value={kpis.topModel}
          format="raw"
          icon={<Trophy className="h-4 w-4" />}
          subtitle="Most used model"
        />
        <MetricCard
          title="Top Model Share"
          value={kpis.topModelPct}
          format="percent"
          icon={<Percent className="h-4 w-4" />}
          subtitle={`${kpis.topModel} usage share`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
        <ModelUsageBarChart data={modelBreakdown} />

        <div className="lg:col-span-1">
          <ModelTrendChart data={modelTrend} models={topModels} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 mb-6">
        <ModelFeatureTable data={modelByFeature} />
      </div>

      {topLangByModel.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {topLangByModel.map(({ model, languages }) => (
            <Card key={model}>
              <CardHeader>
                <CardTitle className="text-sm">{model}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {languages.map((lang) => {
                    const maxInteractions = languages[0]?.interactions ?? 1;
                    const pct = ((lang.interactions ?? 0) / maxInteractions) * 100;
                    return (
                      <div key={lang.language} className="flex items-center gap-3">
                        <span className="w-20 text-xs text-[hsl(var(--muted-foreground))] truncate">{lang.language}</span>
                        <div className="flex-1 h-2 rounded-full bg-[hsl(var(--muted))]">
                          <div
                            className="h-2 rounded-full bg-[hsl(var(--primary))]"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums w-16 text-right">{(lang.interactions ?? 0).toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
