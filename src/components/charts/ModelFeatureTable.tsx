"use client";

import { useState, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface ModelFeatureTableProps {
  data: { model: string; feature: string; featureLabel: string; interactions: number }[];
}

export function ModelFeatureTable({ data }: ModelFeatureTableProps) {
  // Pivot: rows = models, columns = features (memoized to avoid re-render loops)
  const models = useMemo(() => [...new Set(data.map((d) => d.model))], [data]);
  const features = useMemo(() => [...new Set(data.map((d) => d.featureLabel))], [data]);
  const lookup = useMemo(() => new Map(data.map((d) => [`${d.model}|||${d.featureLabel}`, d.interactions])), [data]);

  // Compute model totals
  const modelTotals = useMemo(() =>
    models.map((m) => ({
      model: m,
      total: data.filter((d) => d.model === m).reduce((s, d) => s + d.interactions, 0),
    })),
    [data, models]
  );

  // Sort state: "model", "total", or a feature label
  const [sortCol, setSortCol] = useState<string>("total");
  const [sortAsc, setSortAsc] = useState(false);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(false);
    }
  };

  const indicator = (col: string) => sortCol === col ? (sortAsc ? " ↑" : " ↓") : "";

  const sortedModelTotals = useMemo(() => {
    return [...modelTotals].sort((a, b) => {
      let cmp: number;
      if (sortCol === "model") {
        cmp = a.model.localeCompare(b.model);
      } else if (sortCol === "total") {
        cmp = a.total - b.total;
      } else {
        const aVal = lookup.get(`${a.model}|||${sortCol}`) ?? 0;
        const bVal = lookup.get(`${b.model}|||${sortCol}`) ?? 0;
        cmp = aVal - bVal;
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [modelTotals, sortCol, sortAsc, lookup]);

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
                  <th
                    className="pb-3 pr-4 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))] transition-colors"
                    onClick={() => handleSort("model")}
                  >
                    Model{indicator("model")}
                  </th>
                  {features.map((f) => (
                    <th
                      key={f}
                      className="pb-3 pr-4 font-medium text-right cursor-pointer select-none hover:text-[hsl(var(--foreground))] transition-colors"
                      onClick={() => handleSort(f)}
                    >
                      {f}{indicator(f)}
                    </th>
                  ))}
                  <th
                    className="pb-3 font-medium text-right cursor-pointer select-none hover:text-[hsl(var(--foreground))] transition-colors"
                    onClick={() => handleSort("total")}
                  >
                    Total{indicator("total")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedModelTotals.map(({ model, total }) => (
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
