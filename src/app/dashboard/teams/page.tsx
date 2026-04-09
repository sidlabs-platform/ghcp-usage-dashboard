"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, UserCheck, Bot, Code2, MessageSquare, Terminal } from "lucide-react";

interface TeamSummary {
  teamSlug: string;
  teamName: string;
  source: string;
  orgSlug: string | null;
  totalMembers: number;
  avgDailyActiveUsers: number;
  totalLocAdded: number;
  totalInteractions: number;
  overallAcceptanceRate: number;
  agentAdoptionRate: number;
  chatAdoptionRate: number;
  cliAdoptionRate: number;
  codeReviewAdoptionRate: number;
}

interface FilterOptions {
  enterpriseTeams: { slug: string; name: string; memberCount: number }[];
  orgTeams: { slug: string; name: string; orgSlug: string; memberCount: number }[];
  orgs: { slug: string; name: string }[];
}

type SortField = "teamName" | "totalMembers" | "avgDailyActiveUsers" | "totalLocAdded" | "overallAcceptanceRate" | "agentAdoptionRate" | "chatAdoptionRate" | "cliAdoptionRate";

export default function TeamsPage() {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("totalMembers");
  const [sortAsc, setSortAsc] = useState(false);
  const [filters, setFilters] = useState<FilterOptions>({ enterpriseTeams: [], orgTeams: [], orgs: [] });
  const [selectedEntTeams, setSelectedEntTeams] = useState<string[]>([]);
  const [selectedOrgTeams, setSelectedOrgTeams] = useState<string[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);

  // Fetch filter options once
  useEffect(() => {
    fetch("/api/filters")
      .then((res) => res.json())
      .then((json) => { if (!json.error) setFilters(json); })
      .catch(() => {});
  }, []);

  const fetchTeams = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    const allTeams = [...selectedEntTeams, ...selectedOrgTeams];
    if (allTeams.length > 0) params.set("teams", allTeams.join(","));

    fetch(`/api/teams?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        let result: TeamSummary[] = json.teams ?? [];
        // Client-side org filtering
        if (selectedOrgs.length > 0) {
          const orgSet = new Set(selectedOrgs);
          result = result.filter((t) => t.orgSlug && orgSet.has(t.orgSlug));
        }
        setTeams(result);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedEntTeams, selectedOrgTeams, selectedOrgs]);

  useEffect(() => { fetchTeams(); }, [fetchTeams]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortedTeams = [...teams].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (typeof aVal === "string" && typeof bVal === "string") {
      return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortAsc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

  const sortIndicator = (field: SortField) =>
    sortField === field ? (sortAsc ? " ↑" : " ↓") : "";

  if (loading && teams.length === 0) {
    return (
      <div>
        <PageHeader title="Team Analytics" description="Copilot adoption and usage by team" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50" />
          ))}
        </div>
      </div>
    );
  }

  if (error && teams.length === 0) {
    return (
      <div>
        <PageHeader title="Team Analytics" description="Copilot adoption and usage by team" />
        <ScopeFilter
          enterpriseTeams={filters.enterpriseTeams} orgTeams={filters.orgTeams}
          orgs={filters.orgs}
          selectedEnterpriseTeams={selectedEntTeams} selectedOrgTeams={selectedOrgTeams}
          selectedOrgs={selectedOrgs}
          onEnterpriseTeamsChange={setSelectedEntTeams} onOrgTeamsChange={setSelectedOrgTeams}
          onOrgsChange={setSelectedOrgs}
        />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">{error}</div>
      </div>
    );
  }

  const totalTeams = teams.length;
  const totalMembers = teams.reduce((s, t) => s + t.totalMembers, 0);
  const totalLocAdded = teams.reduce((s, t) => s + t.totalLocAdded, 0);
  const avgAcceptance = teams.length > 0
    ? teams.reduce((s, t) => s + t.overallAcceptanceRate, 0) / teams.length
    : 0;
  const avgAgentAdoption = teams.length > 0
    ? teams.reduce((s, t) => s + t.agentAdoptionRate, 0) / teams.length
    : 0;

  return (
    <div>
      <PageHeader
        title="Team Analytics"
        description="Copilot adoption and usage by team"
      />

      <ScopeFilter
        enterpriseTeams={filters.enterpriseTeams} orgTeams={filters.orgTeams}
        orgs={filters.orgs}
        selectedEnterpriseTeams={selectedEntTeams} selectedOrgTeams={selectedOrgTeams}
        selectedOrgs={selectedOrgs}
        onEnterpriseTeamsChange={setSelectedEntTeams} onOrgTeamsChange={setSelectedOrgTeams}
        onOrgsChange={setSelectedOrgs}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-8">
        <MetricCard
          title="Total Teams"
          value={totalTeams}
          icon={<Users className="h-4 w-4" />}
          subtitle={selectedEntTeams.length > 0 || selectedOrgTeams.length > 0 || selectedOrgs.length > 0 ? "In selected scope" : "Synced teams"}
        />
        <MetricCard
          title="Total Members"
          value={totalMembers}
          icon={<UserCheck className="h-4 w-4" />}
          subtitle="Across teams"
        />
        <MetricCard
          title="Total LoC Added"
          value={totalLocAdded}
          icon={<Code2 className="h-4 w-4" />}
          subtitle="Across teams"
        />
        <MetricCard
          title="Avg Acceptance Rate"
          value={avgAcceptance}
          format="percent"
          icon={<Code2 className="h-4 w-4" />}
          subtitle="Across teams"
        />
        <MetricCard
          title="Avg Agent Adoption"
          value={avgAgentAdoption}
          format="percent"
          icon={<Bot className="h-4 w-4" />}
          subtitle="Across teams"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team Leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          {teams.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              No team data available. Sync teams to populate this table.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                    <th className="pb-3 pr-4 font-medium cursor-pointer" onClick={() => handleSort("teamName")}>
                      Team{sortIndicator("teamName")}
                    </th>
                    <th className="pb-3 pr-4 font-medium text-right cursor-pointer" onClick={() => handleSort("totalMembers")}>
                      Members{sortIndicator("totalMembers")}
                    </th>
                    <th className="pb-3 pr-4 font-medium text-right cursor-pointer" onClick={() => handleSort("avgDailyActiveUsers")}>
                      Active Users{sortIndicator("avgDailyActiveUsers")}
                    </th>
                    <th className="pb-3 pr-4 font-medium text-right cursor-pointer" onClick={() => handleSort("totalLocAdded")}>
                      LoC Added{sortIndicator("totalLocAdded")}
                    </th>
                    <th className="pb-3 pr-4 font-medium text-right cursor-pointer" onClick={() => handleSort("overallAcceptanceRate")}>
                      Acceptance %{sortIndicator("overallAcceptanceRate")}
                    </th>
                    <th className="pb-3 pr-4 font-medium text-right cursor-pointer" onClick={() => handleSort("agentAdoptionRate")}>
                      Agent{sortIndicator("agentAdoptionRate")}
                    </th>
                    <th className="pb-3 pr-4 font-medium text-right cursor-pointer" onClick={() => handleSort("chatAdoptionRate")}>
                      Chat{sortIndicator("chatAdoptionRate")}
                    </th>
                    <th className="pb-3 font-medium text-right cursor-pointer" onClick={() => handleSort("cliAdoptionRate")}>
                      CLI{sortIndicator("cliAdoptionRate")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTeams.map((team, idx) => {
                    const adoption = team.totalMembers > 0
                      ? ((team.avgDailyActiveUsers / team.totalMembers) * 100)
                      : 0;
                    return (
                      <tr key={`${team.teamSlug}-${idx}`} className="border-b last:border-0">
                        <td className="py-3 pr-4">
                          <span className="font-medium">{team.teamName}</span>
                          <Badge variant="outline" className="ml-2 text-[10px]">{team.source}</Badge>
                        </td>
                        <td className="py-3 pr-4 text-right">{team.totalMembers}</td>
                        <td className="py-3 pr-4 text-right">
                          {team.avgDailyActiveUsers.toFixed(1)}
                          <span className="ml-1 text-xs text-[hsl(var(--muted-foreground))]">
                            ({adoption.toFixed(0)}%)
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-right">{team.totalLocAdded.toLocaleString()}</td>
                        <td className="py-3 pr-4 text-right">{team.overallAcceptanceRate.toFixed(1)}%</td>
                        <td className="py-3 pr-4 text-right">
                          <Badge variant={team.agentAdoptionRate >= 50 ? "success" : team.agentAdoptionRate >= 20 ? "warning" : "secondary"}>
                            {team.agentAdoptionRate.toFixed(1)}%
                          </Badge>
                        </td>
                        <td className="py-3 pr-4 text-right">
                          <Badge variant={team.chatAdoptionRate >= 50 ? "success" : team.chatAdoptionRate >= 20 ? "warning" : "secondary"}>
                            {team.chatAdoptionRate.toFixed(1)}%
                          </Badge>
                        </td>
                        <td className="py-3 text-right">
                          <Badge variant={team.cliAdoptionRate >= 50 ? "success" : team.cliAdoptionRate >= 20 ? "warning" : "secondary"}>
                            {team.cliAdoptionRate.toFixed(1)}%
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
