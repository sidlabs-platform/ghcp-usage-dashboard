"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { CLIUsersTrendChart } from "@/components/charts/CLIUsersTrendChart";
import { CLITokenChart } from "@/components/charts/CLITokenChart";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Terminal, Activity, Zap, Hash } from "lucide-react";

interface DailyTrendDay {
  day: string;
  cliUsers: number;
  ideUsers: number;
}

interface DailyTokenDay {
  day: string;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  avgPerRequest: number;
}

interface CLIUser {
  login: string;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  days: number;
}

interface CLIData {
  dailyTrend: DailyTrendDay[];
  dailyTokens: DailyTokenDay[];
  kpis: {
    dailyCliUsers: number;
    sessionsToday: number;
    requestsToday: number;
    avgTokensPerRequest: number;
  };
  topCliUsers: CLIUser[];
}

export default function CLIPage() {
  const [data, setData] = useState<CLIData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/metrics/cli")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div>
        <PageHeader title="CLI Analytics" description="Copilot CLI usage, sessions, and token consumption" />
        <div className="flex h-64 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          Loading CLI metrics…
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="CLI Analytics" description="Copilot CLI usage, sessions, and token consumption" />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const tokenChartData = data.dailyTokens.map((d) => ({
    day: d.day,
    promptTokens: d.promptTokens,
    outputTokens: d.outputTokens,
    avgPerRequest: d.avgPerRequest,
  }));

  return (
    <div>
      <PageHeader
        title="CLI Analytics"
        description="Copilot CLI usage, sessions, and token consumption"
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="Daily CLI Users"
          value={data.kpis.dailyCliUsers}
          icon={<Terminal className="h-4 w-4" />}
          subtitle="Latest day"
        />
        <MetricCard
          title="Sessions Today"
          value={data.kpis.sessionsToday}
          icon={<Activity className="h-4 w-4" />}
          subtitle="Latest day"
        />
        <MetricCard
          title="Requests Today"
          value={data.kpis.requestsToday}
          icon={<Zap className="h-4 w-4" />}
          subtitle="Latest day"
        />
        <MetricCard
          title="Avg Tokens/Request"
          value={data.kpis.avgTokensPerRequest}
          icon={<Hash className="h-4 w-4" />}
          subtitle="Latest day"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
        <CLIUsersTrendChart data={data.dailyTrend} />
        <CLITokenChart data={tokenChartData} />
      </div>

      {/* Top CLI Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>Top CLI Users</CardTitle>
        </CardHeader>
        <CardContent>
          {data.topCliUsers.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              No CLI user data available
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                    <th className="pb-3 pr-4 font-medium">User</th>
                    <th className="pb-3 pr-4 font-medium text-right">Sessions</th>
                    <th className="pb-3 pr-4 font-medium text-right">Requests</th>
                    <th className="pb-3 pr-4 font-medium text-right">Prompt Tokens</th>
                    <th className="pb-3 pr-4 font-medium text-right">Output Tokens</th>
                    <th className="pb-3 font-medium text-right">Active Days</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topCliUsers.map((user) => (
                    <tr key={user.login} className="border-b last:border-0">
                      <td className="py-3 pr-4 font-medium">{user.login}</td>
                      <td className="py-3 pr-4 text-right">{user.sessions.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-right">{user.requests.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-right">{user.promptTokens.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-right">{user.outputTokens.toLocaleString()}</td>
                      <td className="py-3 text-right">{user.days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
