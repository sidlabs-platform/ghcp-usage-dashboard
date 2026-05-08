"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useDateRange } from "@/contexts/DateRangeContext";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber, formatPercent } from "@/lib/utils";
import { CHART_COLORS } from "@/lib/constants";
import { ArrowLeft, Calendar, Code, MessageSquare, CheckCircle } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

interface DailyActivity {
  day: string;
  codeGen: number;
  codeAccept: number;
  locSuggested: number;
  locAccepted: number;
  interactions: number;
}

interface UserSummary {
  totalActiveDays: number;
  totalLocAdded: number;
  totalLocAccepted: number;
  totalInteractions: number;
  totalCodeGen: number;
  totalCodeAccept: number;
  acceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReview: boolean;
}

interface TopLanguage {
  language: string;
  suggestions: number;
  acceptances: number;
}

interface TopModel {
  model: string;
  interactions: number;
}

interface IdeUsage {
  ide: string;
  interactions: number;
}

interface UserDetailData {
  user: string;
  dailyActivity: DailyActivity[];
  summary: UserSummary | null;
  topLanguages: TopLanguage[];
  topModels: TopModel[];
  ideUsage: IdeUsage[];
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-28 rounded-xl border bg-[hsl(var(--card))] animate-pulse" />
        ))}
      </div>
      <div className="h-80 rounded-xl border bg-[hsl(var(--card))] animate-pulse flex items-center justify-center">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">Loading chart...</span>
      </div>
    </div>
  );
}

function ActivityChart({ data }: { data: DailyActivity[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Area
                type="monotone"
                dataKey="locSuggested"
                name="LoC Suggested"
                stroke={CHART_COLORS.locSuggested}
                fill={CHART_COLORS.locSuggested}
                fillOpacity={0.15}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="locAccepted"
                name="LoC Accepted"
                stroke={CHART_COLORS.locAccepted}
                fill={CHART_COLORS.locAccepted}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function LanguagesChart({ data }: { data: TopLanguage[] }) {
  if (data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Languages</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, left: 80, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis dataKey="language" type="category" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" width={75} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Bar dataKey="suggestions" name="Suggestions" fill={CHART_COLORS.primary} radius={[0, 4, 4, 0]} />
              <Bar dataKey="acceptances" name="Acceptances" fill={CHART_COLORS.success} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function ModelsChart({ data }: { data: TopModel[] }) {
  if (data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Models</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, left: 80, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis dataKey="model" type="category" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" width={75} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Bar dataKey="interactions" name="Interactions" fill={CHART_COLORS.secondary} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function IdeUsageCard({ data }: { data: IdeUsage[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.interactions), 1);
  return (
    <Card>
      <CardHeader>
        <CardTitle>IDE Usage</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {data.map((item) => (
            <div key={item.ide} className="flex items-center gap-3">
              <span className="text-sm w-32 truncate" title={item.ide}>{item.ide}</span>
              <div className="flex-1 h-6 bg-[hsl(var(--muted))] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(item.interactions / max) * 100}%`,
                    backgroundColor: CHART_COLORS.info,
                  }}
                />
              </div>
              <span className="text-sm font-medium w-12 text-right">{item.interactions}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function UserDetailPage() {
  const params = useParams();
  const login = typeof params.login === "string" ? decodeURIComponent(params.login) : "";
  const { days } = useDateRange();
  const [data, setData] = useState<UserDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!login) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    fetch(`/api/users/${encodeURIComponent(login)}?days=${days}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch user data (${res.status})`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [login, days]);

  return (
    <div>
      <Link
        href="/dashboard/users"
        className="inline-flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to User Explorer
      </Link>

      <PageHeader title={login} description="Individual developer Copilot usage details" />

      {loading && <LoadingSkeleton />}

      {error && (
        <div className="text-center py-12 text-[hsl(var(--destructive))]">
          <p>Error: {error}</p>
        </div>
      )}

      {!loading && !error && data && !data.summary && (
        <div className="text-center py-12 text-[hsl(var(--muted-foreground))]">
          No data found for this user in the selected time range.
        </div>
      )}

      {!loading && !error && data && data.summary && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
                  <Calendar className="h-4 w-4" />
                  Active Days
                </div>
                <p className="text-2xl font-bold mt-1">{data.summary.totalActiveDays}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
                  <Code className="h-4 w-4" />
                  LoC Suggested
                </div>
                <p className="text-2xl font-bold mt-1">{formatNumber(data.summary.totalLocAdded)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
                  <MessageSquare className="h-4 w-4" />
                  Total Interactions
                </div>
                <p className="text-2xl font-bold mt-1">{formatNumber(data.summary.totalInteractions)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
                  <CheckCircle className="h-4 w-4" />
                  Acceptance Rate
                </div>
                <p className="text-2xl font-bold mt-1">{formatPercent(data.summary.acceptanceRate)}</p>
              </CardContent>
            </Card>
          </div>

          {/* Feature badges */}
          <div className="flex gap-2 flex-wrap">
            {data.summary.usedAgent && <Badge variant="default">Agent</Badge>}
            {data.summary.usedChat && <Badge variant="secondary">Chat</Badge>}
            {data.summary.usedCli && <Badge variant="success">CLI</Badge>}
            {data.summary.usedCodeReview && <Badge variant="warning">Code Review</Badge>}
          </div>

          {/* Charts */}
          {data.dailyActivity.length > 0 && <ActivityChart data={data.dailyActivity} />}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <LanguagesChart data={data.topLanguages} />
            <ModelsChart data={data.topModels} />
          </div>

          <IdeUsageCard data={data.ideUsage} />
        </div>
      )}
    </div>
  );
}
