"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useDateRange } from "@/contexts/DateRangeContext";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DateFilter } from "@/components/filters/DateFilter";
import { formatNumber } from "@/lib/utils";
import { CHART_COLORS, FEATURE_LABELS, CHAT_MODE_LABELS, CHAT_MODE_COLORS } from "@/lib/constants";
import {
  ArrowLeft, Calendar, MessageSquare, CheckCircle,
  FileCode, FileCheck, FileX, Bot, Terminal, Sparkles,
  AppWindow, Send, Hash, ArrowRight,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────

interface DailyActivity {
  day: string;
  codeGen: number;
  codeAccept: number;
  locSuggested: number;
  locAccepted: number;
  locSuggestedDelete: number;
  locDeleted: number;
  interactions: number;
  aiCreditsUsed: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  // Strict completion-only LoC (server-computed via the IS_COMPLETION_SQL
  // allowlist) — the same basis as summary.totalLocSuggested/
  // completionLocAccepted/completionLocDeleted, so the daily chart and the
  // summary card agree.
  completionLocSuggested: number;
  completionLocAccepted: number;
  completionLocDeleted: number;
  // Strict completion-only counterpart to locSuggestedDelete (top-level
  // loc_suggested_to_delete_sum). Used by the chart instead of
  // locSuggestedDelete so the "Suggested (Delete)" series never includes
  // copilot_app/chat_inline/unknown/agent_edit suggested-deletion activity.
  completionLocSuggestedDelete: number;
  appLocAdded: number;
  appLocDeleted: number;
}

interface UserSummary {
  totalActiveDays: number;
  totalLocAdded: number;
  totalLocAccepted: number;
  totalLocSuggestedDelete: number;
  totalLocDeleted: number;
  totalInteractions: number;
  totalAiCreditsUsed: number;
  totalCodeGen: number;
  totalCodeAccept: number;
  acceptanceRate: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  // Completion-only fields (excludes agent_edit)
  totalLocSuggested: number;
  completionLocAccepted: number;
  completionLocDeleted: number;
  completionAcceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReview: boolean;
  usedCodingAgent: boolean;
  usedCodeReviewPassive: boolean;
  // Three-state: true = actual App activity (flag or real metrics); false =
  // supported but never used; null/undefined = no App evidence at all
  // (legacy data). Only `true` shows the badge and the App activity section.
  usedCopilotApp?: boolean | null;
}

interface CopilotAppStats {
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  avgTokensPerRequest: number;
  codeGenerations: number;
  codeAcceptances: number;
  locAdded: number;
  locDeleted: number;
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

interface FeatureUsageRow {
  feature: string;
  interactions: number;
  codeGen: number;
  codeAccept: number;
  locAdded: number;
}

interface ChatModes {
  agent: number;
  ask: number;
  edit: number;
  plan: number;
  custom: number;
  unknown: number;
}

interface CliStats {
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
}

interface UserDetailData {
  user: string;
  dailyActivity: DailyActivity[];
  summary: UserSummary | null;
  topLanguages: TopLanguage[];
  topModels: TopModel[];
  ideUsage: IdeUsage[];
  featureUsage: FeatureUsageRow[];
  chatModes: ChatModes;
  cliStats: CliStats | null;
  copilotAppStats: CopilotAppStats | null;
}

// ── Helpers ───────────────────────────────────────────────────────────

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "8px",
};

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mt-2">
      {children}
    </h2>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-28 rounded-xl border bg-[hsl(var(--card))] animate-pulse" />
        ))}
      </div>
      <div className="h-80 rounded-xl border bg-[hsl(var(--card))] animate-pulse flex items-center justify-center">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">Loading charts...</span>
      </div>
    </div>
  );
}

// ── Chart Components ──────────────────────────────────────────────────

function LocTrendChart({ data }: { data: DailyActivity[] }) {
  const chartData = useMemo(() => data.map((d) => ({
    day: d.day,
    completionLocSuggested: d.completionLocSuggested,
    completionLocAccepted: d.completionLocAccepted,
    agentLocAdded: d.agentLocAdded,
    completionLocSuggestedDelete: d.completionLocSuggestedDelete,
    completionLocDeleted: d.completionLocDeleted,
  })), [data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lines of Code — Daily Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              {/* completionLocSuggested/completionLocAccepted/completionLocDeleted/
                  completionLocSuggestedDelete are all server-computed via the strict
                  IS_COMPLETION_SQL allowlist — the same fields the summary cards use —
                  so this chart and the cards never disagree, and copilot_app/chat_inline/
                  unknown/agent_edit activity never inflates these series. */}
              <Area
                type="monotone" dataKey="completionLocSuggested" name="LoC Suggested"
                stroke={CHART_COLORS.locSuggested} fill={CHART_COLORS.locSuggested}
                fillOpacity={0.15} strokeWidth={2}
              />
              <Area
                type="monotone" dataKey="completionLocAccepted" name="LoC Accepted (Completions)"
                stroke={CHART_COLORS.locAccepted} fill={CHART_COLORS.locAccepted}
                fillOpacity={0.15} strokeWidth={2}
              />
              <Area
                type="monotone" dataKey="agentLocAdded" name="Agent LoC Added"
                stroke={CHART_COLORS.agent} fill={CHART_COLORS.agent}
                fillOpacity={0.10} strokeWidth={1.5} strokeDasharray="4 2"
              />
              <Area
                type="monotone" dataKey="completionLocSuggestedDelete" name="LoC Suggested (Delete)"
                stroke={CHART_COLORS.danger} fill={CHART_COLORS.danger}
                fillOpacity={0.08} strokeWidth={1.5} strokeDasharray="4 2"
              />
              <Area
                type="monotone" dataKey="completionLocDeleted" name="LoC Deleted (Completions)"
                stroke={CHART_COLORS.locDeleted} fill={CHART_COLORS.locDeleted}
                fillOpacity={0.08} strokeWidth={1.5} strokeDasharray="4 2"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function InteractionsTrendChart({ data }: { data: DailyActivity[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Interactions & Code Activity — Daily Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Area
                type="monotone" dataKey="interactions" name="Interactions"
                stroke={CHART_COLORS.secondary} fill={CHART_COLORS.secondary}
                fillOpacity={0.15} strokeWidth={2}
              />
              <Area
                type="monotone" dataKey="codeGen" name="Code Generations"
                stroke={CHART_COLORS.primary} fill={CHART_COLORS.primary}
                fillOpacity={0.1} strokeWidth={1.5}
              />
              <Area
                type="monotone" dataKey="codeAccept" name="Code Acceptances"
                stroke={CHART_COLORS.success} fill={CHART_COLORS.success}
                fillOpacity={0.1} strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function FeatureUsageChart({ data }: { data: FeatureUsageRow[] }) {
  if (data.length === 0) return null;
  const labeled = data.map((d) => ({
    ...d,
    label: FEATURE_LABELS[d.feature] ?? d.feature,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Feature Usage Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={labeled} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Bar dataKey="locAdded" name="LoC Added" fill={CHART_COLORS.locAdded} radius={[4, 4, 0, 0]} />
              <Bar dataKey="interactions" name="Interactions" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
              <Bar dataKey="codeAccept" name="Acceptances" fill={CHART_COLORS.locAccepted} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function ChatModeChart({ data }: { data: ChatModes }) {
  const pieData = useMemo(() => {
    return Object.entries(data)
      .filter(([, value]) => value > 0)
      .map(([key, value]) => ({
        name: CHAT_MODE_LABELS[key] ?? key,
        value,
        color: CHAT_MODE_COLORS[key] ?? CHART_COLORS.unknown,
      }));
  }, [data]);

  const total = pieData.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  const RADIAN = Math.PI / 180;
  const renderLabel = ({
    cx, cy, midAngle, innerRadius, outerRadius, percent, name,
  }: {
    cx: number; cy: number; midAngle: number;
    innerRadius: number; outerRadius: number; percent: number; name: string;
  }) => {
    if (percent < 0.04) return null;
    const radius = innerRadius + (outerRadius - innerRadius) * 1.45;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);
    return (
      <text x={x} y={y} fill="hsl(var(--muted-foreground))" textAnchor={x > cx ? "start" : "end"}
        dominantBaseline="central" fontSize={12}>
        {name} ({(percent * 100).toFixed(0)}%)
      </text>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Mode Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={105}
              paddingAngle={2} dataKey="value" label={renderLabel} labelLine={false}>
              {pieData.map((entry, i) => (
                <Cell key={`cell-${i}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip formatter={(value: number, name: string) => [value.toLocaleString(), name]} />
          </PieChart>
        </ResponsiveContainer>
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
              <Tooltip contentStyle={tooltipStyle} />
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
              <Tooltip contentStyle={tooltipStyle} />
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

function CliStatsCard({ data }: { data: CliStats }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          CLI Activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Sessions</p>
            <p className="text-2xl font-bold mt-1">{formatNumber(data.sessions)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Requests</p>
            <p className="text-2xl font-bold mt-1">{formatNumber(data.requests)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Prompt Tokens</p>
            <p className="text-2xl font-bold mt-1">{formatNumber(data.promptTokens)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Output Tokens</p>
            <p className="text-2xl font-bold mt-1">{formatNumber(data.outputTokens)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Copilot App activity — only rendered when actual App activity was detected
// (summary.usedCopilotApp === true), never for "supported but unused" or
// "no evidence" cases. See usedCopilotApp's three-state doc comment above.
function CopilotAppStatsSection({ data }: { data: CopilotAppStats }) {
  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SectionHeader>Copilot App Activity</SectionHeader>
        <Link
          href="/dashboard/copilot-app"
          className="inline-flex items-center gap-1 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
        >
          View Copilot App Analytics
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          title="Sessions"
          value={data.sessions}
          icon={<AppWindow className="h-4 w-4" />}
          accent="violet"
        />
        <MetricCard
          title="Requests"
          value={data.requests}
          icon={<Send className="h-4 w-4" />}
          accent="blue"
        />
        <MetricCard
          title="Prompts"
          value={data.prompts}
          icon={<MessageSquare className="h-4 w-4" />}
          accent="teal"
        />
        <MetricCard
          title="Tokens / Request"
          value={data.avgTokensPerRequest}
          format="raw"
          icon={<Hash className="h-4 w-4" />}
          accent="amber"
          subtitle="(Prompt + output) ÷ requests"
        />
        <MetricCard
          title="App LoC"
          value={data.locAdded}
          icon={<FileCode className="h-4 w-4" />}
          accent="green"
          subtitle={`${formatNumber(data.locDeleted)} deleted`}
        />
        <MetricCard
          title="Code Generations"
          value={data.codeGenerations}
          icon={<Sparkles className="h-4 w-4" />}
          accent="teal"
          subtitle={`${formatNumber(data.codeAcceptances)} accepted`}
        />
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────

export default function UserDetailPage() {
  const params = useParams();
  const login = typeof params.login === "string" ? decodeURIComponent(params.login) : "";
  const { mode, days, startDate, endDate } = useDateRange();
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

    const qp = new URLSearchParams();
    if (mode === "custom") {
      qp.set("startDate", startDate);
      qp.set("endDate", endDate);
    } else {
      qp.set("days", String(days));
    }

    fetch(`/api/users/${encodeURIComponent(login)}?${qp}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch user data (${res.status})`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [login, mode, days, startDate, endDate]);

  const hasChatActivity = useMemo(() => {
    if (!data?.chatModes) return false;
    const m = data.chatModes;
    return m.agent + m.ask + m.edit + m.plan + m.custom + m.unknown > 0;
  }, [data?.chatModes]);

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
      <DateFilter />

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

          {/* ── KPI Strip: Activity & Productivity ────────────────────── */}
          <SectionHeader>Activity &amp; Productivity</SectionHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Active Days"
              value={data.summary.totalActiveDays}
              format="raw"
              icon={<Calendar className="h-4 w-4" />}
              accent="blue"
            />
            <MetricCard
              title="Total Interactions"
              value={data.summary.totalInteractions}
              icon={<MessageSquare className="h-4 w-4" />}
              accent="violet"
            />
            <MetricCard
              title="AI Credits Used"
              value={data.summary.totalAiCreditsUsed > 0
                ? data.summary.totalAiCreditsUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : "—"}
              format="raw"
              icon={<Sparkles className="h-4 w-4" />}
              accent="amber"
              subtitle="Usage Metrics API"
            />
            <MetricCard
              title="Code Generations"
              value={data.summary.totalCodeGen}
              icon={<Sparkles className="h-4 w-4" />}
              accent="teal"
              subtitle={`${formatNumber(data.summary.totalCodeAccept)} accepted`}
            />
            <MetricCard
              title="Acceptance Rate"
              value={data.summary.completionAcceptanceRate}
              format="percent"
              icon={<CheckCircle className="h-4 w-4" />}
              accent="green"
            />
          </div>

          {/* ── KPI Strip: Lines of Code ──────────────────────────────── */}
          <SectionHeader>Lines of Code</SectionHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="LoC Suggested"
              value={data.summary.totalLocSuggested}
              icon={<FileCode className="h-4 w-4" />}
              accent="blue"
              subtitle="Completions only"
            />
            <MetricCard
              title="LoC Accepted"
              value={data.summary.completionLocAccepted}
              icon={<FileCheck className="h-4 w-4" />}
              accent="green"
              subtitle="Completions only"
            />
            <MetricCard
              title="LoC Deleted"
              value={data.summary.completionLocDeleted}
              icon={<FileX className="h-4 w-4" />}
              accent="red"
              subtitle={`${formatNumber(data.summary.totalLocSuggestedDelete)} suggested`}
            />
            {data.summary.agentLocAdded > 0 || data.summary.agentLocDeleted > 0 ? (
              <MetricCard
                title="Agent LoC"
                value={data.summary.agentLocAdded}
                icon={<Bot className="h-4 w-4" />}
                accent="violet"
                subtitle={data.summary.agentLocDeleted > 0 ? `${formatNumber(data.summary.agentLocDeleted)} deleted` : undefined}
              />
            ) : (
              <MetricCard
                title="Agent LoC"
                value="—"
                format="raw"
                icon={<Bot className="h-4 w-4" />}
                subtitle="No agent edits in period"
              />
            )}
          </div>

          {/* ── Feature badges ────────────────────────────────────────── */}
          <div className="flex gap-2 flex-wrap">
            {data.summary.usedAgent && <Badge variant="default">Agent</Badge>}
            {data.summary.usedChat && <Badge variant="secondary">Chat</Badge>}
            {data.summary.usedCli && <Badge variant="success">CLI</Badge>}
            {data.summary.usedCodeReview && <Badge variant="warning">Code Review</Badge>}
            {data.summary.usedCodingAgent && <Badge variant="secondary">Coding Agent</Badge>}
            {data.summary.usedCodeReviewPassive && <Badge variant="warning">Code Review (Passive)</Badge>}
            {data.summary.usedCopilotApp && <Badge variant="secondary">Copilot App</Badge>}
          </div>

          {/* ── Activity trends ───────────────────────────────────────── */}
          {data.dailyActivity.length > 0 && (
            <>
              <SectionHeader>Daily Trends</SectionHeader>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <LocTrendChart data={data.dailyActivity} />
                <InteractionsTrendChart data={data.dailyActivity} />
              </div>
            </>
          )}

          {/* ── Feature usage & Chat modes ────────────────────────────── */}
          {(data.featureUsage.length > 0 || hasChatActivity) && (
            <>
              <SectionHeader>Feature &amp; Chat Usage</SectionHeader>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <FeatureUsageChart data={data.featureUsage} />
                {hasChatActivity && <ChatModeChart data={data.chatModes} />}
              </div>
            </>
          )}

          {/* ── Languages & Models ────────────────────────────────────── */}
          {(data.topLanguages.length > 0 || data.topModels.length > 0) && (
            <>
              <SectionHeader>Languages &amp; Models</SectionHeader>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <LanguagesChart data={data.topLanguages} />
                <ModelsChart data={data.topModels} />
              </div>
            </>
          )}

          {/* ── IDE & CLI ─────────────────────────────────────────────── */}
          {(data.ideUsage.length > 0 || data.cliStats) && (
            <>
              <SectionHeader>IDE &amp; CLI</SectionHeader>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <IdeUsageCard data={data.ideUsage} />
                {data.cliStats && <CliStatsCard data={data.cliStats} />}
              </div>
            </>
          )}

          {/* ── Copilot App ───────────────────────────────────────────── */}
          {data.summary.usedCopilotApp === true && data.copilotAppStats && (
            <CopilotAppStatsSection data={data.copilotAppStats} />
          )}
        </div>
      )}
    </div>
  );
}
