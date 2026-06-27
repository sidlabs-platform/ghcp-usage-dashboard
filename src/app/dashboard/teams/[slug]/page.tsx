"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { useDateRange } from "@/contexts/DateRangeContext";
import { MetricCard } from "@/components/cards/MetricCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DateFilter } from "@/components/filters/DateFilter";
import { Users, Activity, Code, TrendingUp, Bot, MessageSquare, Terminal } from "lucide-react";
import { formatNumber, safeNum } from "@/lib/utils";

interface TeamInfo {
  slug: string;
  name: string;
  org: string | null;
  memberCount: number;
}

interface MemberRow {
  login: string;
  activeDays: number;
  locAdded: number;
  interactions: number;
  acceptanceRate: number;
  usedAgent: number;
  usedChat: number;
  usedCli: number;
  usedCodeReview: number;
}

interface Aggregates {
  totalLocAdded: number;
  avgAcceptanceRate: number;
  agentAdoption: number;
  chatAdoption: number;
  cliAdoption: number;
  activeMembers: number;
}

interface TeamDetailResponse {
  team: TeamInfo | null;
  members: MemberRow[];
  aggregates: Aggregates | null;
}

export default function TeamDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const source = searchParams.get("source");
  const enterprise = searchParams.get("enterprise");
  const { mode, days, startDate, endDate } = useDateRange();
  const [data, setData] = useState<TeamDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);

    const qp = new URLSearchParams();
    if (mode === "custom") {
      qp.set("startDate", startDate);
      qp.set("endDate", endDate);
    } else {
      qp.set("days", String(days));
    }
    if (source) {
      qp.set("source", source);
    }
    if (enterprise) {
      qp.set("enterprise", enterprise);
    }

    fetch(`/api/teams/${encodeURIComponent(slug)}?${qp}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load team: ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json as TeamDetailResponse))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [slug, mode, days, startDate, endDate]);

  if (loading) {
    return (
      <div>
        <Link href="/dashboard/teams" className="text-sm text-[hsl(var(--primary))] hover:underline mb-4 inline-block">
          ← Back to Team Analytics
        </Link>
        <PageHeader title="Loading…" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {Array.from({ length: 7 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-4 bg-[hsl(var(--muted))] rounded w-1/2 mb-2" />
                <div className="h-8 bg-[hsl(var(--muted))] rounded w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Link href="/dashboard/teams" className="text-sm text-[hsl(var(--primary))] hover:underline mb-4 inline-block">
          ← Back to Team Analytics
        </Link>
        <PageHeader title="Error" description={error} />
      </div>
    );
  }

  if (!data?.team) {
    return (
      <div>
        <Link href="/dashboard/teams" className="text-sm text-[hsl(var(--primary))] hover:underline mb-4 inline-block">
          ← Back to Team Analytics
        </Link>
        <PageHeader title="Team not found" description={`No team found with slug "${slug}".`} />
      </div>
    );
  }

  const { team, members, aggregates } = data;

  return (
    <div>
      <Link href="/dashboard/teams" className="text-sm text-[hsl(var(--primary))] hover:underline mb-4 inline-block">
        ← Back to Team Analytics
      </Link>
      <PageHeader
        title={team.name}
        description={team.org ? `Organization: ${team.org}` : "Enterprise team"}
      />
      <DateFilter />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 mb-8">
        <MetricCard
          title="Members"
          value={team.memberCount}
          icon={<Users className="h-4 w-4" />}
        />
        <MetricCard
          title="Active Members"
          value={aggregates?.activeMembers ?? 0}
          icon={<Activity className="h-4 w-4" />}
          subtitle={`of ${team.memberCount}`}
        />
        <MetricCard
          title="Total LoC"
          value={aggregates?.totalLocAdded ?? 0}
          icon={<Code className="h-4 w-4" />}
        />
        <MetricCard
          title="Acceptance %"
          value={safeNum(aggregates?.avgAcceptanceRate)}
          format="percent"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <MetricCard
          title="Agent Adoption"
          value={safeNum(aggregates?.agentAdoption)}
          format="percent"
          icon={<Bot className="h-4 w-4" />}
        />
        <MetricCard
          title="Chat Adoption"
          value={safeNum(aggregates?.chatAdoption)}
          format="percent"
          icon={<MessageSquare className="h-4 w-4" />}
        />
        <MetricCard
          title="CLI Adoption"
          value={safeNum(aggregates?.cliAdoption)}
          format="percent"
          icon={<Terminal className="h-4 w-4" />}
        />
      </div>

      {/* Members Table */}
      <Card>
        <CardHeader>
          <CardTitle>Team Members ({members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">No member data available for this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium">Login</th>
                    <th className="pb-2 font-medium text-right">Active Days</th>
                    <th className="pb-2 font-medium text-right">LoC Added</th>
                    <th className="pb-2 font-medium text-right">Interactions</th>
                    <th className="pb-2 font-medium text-right">Acceptance %</th>
                    <th className="pb-2 font-medium">Features</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.login} className="border-b last:border-0 hover:bg-[hsl(var(--muted)/0.5)]">
                      <td className="py-2">
                        <Link
                          href={`/dashboard/users/${m.login}`}
                          className="font-medium text-[hsl(var(--primary))] hover:underline"
                        >
                          {m.login}
                        </Link>
                      </td>
                      <td className="py-2 text-right">{m.activeDays}</td>
                      <td className="py-2 text-right">{formatNumber(m.locAdded)}</td>
                      <td className="py-2 text-right">{formatNumber(m.interactions)}</td>
                      <td className="py-2 text-right">{safeNum(m.acceptanceRate).toFixed(1)}%</td>
                      <td className="py-2">
                        <div className="flex gap-1 flex-wrap">
                                                    {!!m.usedAgent && <Badge variant="default">Agent</Badge>}
                          {!!m.usedChat && <Badge variant="secondary">Chat</Badge>}
                          {!!m.usedCli && <Badge variant="success">CLI</Badge>}
                          {!!m.usedCodeReview && <Badge variant="warning">Code Review</Badge>}
                        </div>
                      </td>
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
