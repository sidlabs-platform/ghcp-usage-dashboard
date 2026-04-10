"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface ModelFeatureTableProps {
  data: { model: string; feature: string; featureLabel: string; interactions: number }[];
}

export function ModelFeatureTable({ data }: ModelFeatureTableProps) {
  // Pivot: rows = models, columns = features
  const models = [...new Set(data.map((d) => d.model))];
  const features = [...new Set(data.map((d) => d.featureLabel))];
  const lookup = new Map(data.map((d) => [`${d.model}|||${d.featureLabel}`, d.interactions]));

  // Sort models by total interactions
  const modelTotals = models.map((m) => ({
    model: m,
    total: data.filter((d) => d.model === m).reduce((s, d) => s + d.interactions, 0),
  })).sort((a, b) => b.total - a.total);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model × Feature Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
            No model-feature data available
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                  <th className="pb-3 pr-4 font-medium">Model</th>
                  {features.map((f) => (
                    <th key={f} className="pb-3 pr-4 font-medium text-right">{f}</th>
                  ))}
                  <th className="pb-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {modelTotals.map(({ model, total }) => (
                  <tr key={model} className="border-b last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-xs">{model}</td>
                    {features.map((f) => {
                      const val = lookup.get(`${model}|||${f}`) ?? 0;
                      return (
                        <td key={f} className="py-2.5 pr-4 text-right tabular-nums">
                          {val > 0 ? val.toLocaleString() : <span className="text-[hsl(var(--muted-foreground))]/40">—</span>}
                        </td>
                      );
                    })}
                    <td className="py-2.5 text-right font-semibold tabular-nums">{total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
