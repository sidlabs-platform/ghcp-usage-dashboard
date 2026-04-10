"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Code2, Activity, Search, Eye, Bot } from "lucide-react";

interface UserRow {
  login: string;
  activeDays: number;
  locAdded: number;
  locDeleted: number;
  interactions: number;
  codeGen: number;
  codeAccept: number;
  acceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReviewActive: boolean;
  usedCodeReviewPassive: boolean;
  usedCodingAgent: boolean;
}

interface FilterOptions {
  enterpriseTeams: { slug: string; name: string; memberCount: number }[];
  orgTeams: { slug: string; name: string; orgSlug: string; memberCount: number }[];
  orgs: { slug: string; name: string }[];
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
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

  const fetchUsers = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    const allTeams = [...selectedEntTeams, ...selectedOrgTeams];
    if (allTeams.length > 0) params.set("teams", allTeams.join(","));
    if (selectedOrgs.length > 0) params.set("orgs", selectedOrgs.join(","));

    fetch(`/api/users?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => { setUsers(json.users ?? []); setError(null); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedEntTeams, selectedOrgTeams, selectedOrgs]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  if (loading && users.length === 0) {
    return (
      <div>
        <PageHeader title="User Explorer" description="Individual developer Copilot usage" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50" />
          ))}
        </div>
      </div>
    );
  }

  if (error && users.length === 0) {
    return (
      <div>
        <PageHeader title="User Explorer" description="Individual developer Copilot usage" />
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

  const filtered = users.filter((u) =>
    u.login.toLowerCase().includes(search.toLowerCase())
  );

  const totalLocAdded = users.reduce((s, u) => s + u.locAdded, 0);
  const totalInteractions = users.reduce((s, u) => s + u.interactions, 0);
  const agentUserCount = users.filter((u) => u.usedAgent).length;
  const codingAgentUserCount = users.filter((u) => u.usedCodingAgent).length;
  const codeReviewActiveCount = users.filter((u) => u.usedCodeReviewActive).length;
  const codeReviewPassiveCount = users.filter((u) => u.usedCodeReviewPassive && !u.usedCodeReviewActive).length;
  const isFiltered = selectedEntTeams.length > 0 || selectedOrgTeams.length > 0 || selectedOrgs.length > 0;

  return (
    <div>
      <PageHeader
        title="User Explorer"
        description="Individual developer Copilot usage"
      />

      <ScopeFilter
        enterpriseTeams={filters.enterpriseTeams} orgTeams={filters.orgTeams}
        orgs={filters.orgs}
        selectedEnterpriseTeams={selectedEntTeams} selectedOrgTeams={selectedOrgTeams}
        selectedOrgs={selectedOrgs}
        onEnterpriseTeamsChange={setSelectedEntTeams} onOrgTeamsChange={setSelectedOrgTeams}
        onOrgsChange={setSelectedOrgs}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
        <MetricCard
          title="Total Users"
          value={users.length}
          icon={<Users className="h-4 w-4" />}
          subtitle={isFiltered ? "In selected scope" : "With activity in period"}
        />
        <MetricCard
          title="Total LoC Added"
          value={totalLocAdded}
          icon={<Code2 className="h-4 w-4" />}
          subtitle="Across all users"
        />
        <MetricCard
          title="Total Interactions"
          value={totalInteractions}
          icon={<Activity className="h-4 w-4" />}
          subtitle="User-initiated"
        />
        <MetricCard
          title="IDE Agent Users"
          value={agentUserCount}
          icon={<Search className="h-4 w-4" />}
          subtitle={`${users.length > 0 ? ((agentUserCount / users.length) * 100).toFixed(1) : 0}% of all users`}
        />
        <MetricCard
          title="Coding Agent Users"
          value={codingAgentUserCount}
          icon={<Bot className="h-4 w-4" />}
          subtitle={`${users.length > 0 ? ((codingAgentUserCount / users.length) * 100).toFixed(1) : 0}% of all users`}
        />
        <MetricCard
          title="Code Review Users"
          value={codeReviewActiveCount + codeReviewPassiveCount}
          icon={<Eye className="h-4 w-4" />}
          subtitle={`${codeReviewActiveCount} active, ${codeReviewPassiveCount} passive-only`}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Users</CardTitle>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
              <input
                type="text"
                placeholder="Search users…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-64 rounded-md border bg-transparent pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              {users.length === 0 ? "No user data available. Sync data to populate." : "No users match your search."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                    <th className="pb-3 pr-4 font-medium">User</th>
                    <th className="pb-3 pr-4 font-medium text-right">Active Days</th>
                    <th className="pb-3 pr-4 font-medium text-right">LoC Added</th>
                    <th className="pb-3 pr-4 font-medium text-right">Interactions</th>
                    <th className="pb-3 pr-4 font-medium text-right">Accept %</th>
                    <th className="pb-3 font-medium">Features</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((user) => (
                    <tr key={user.login} className="border-b last:border-0">
                      <td className="py-3 pr-4 font-medium">{user.login}</td>
                      <td className="py-3 pr-4 text-right">{user.activeDays}</td>
                      <td className="py-3 pr-4 text-right">{user.locAdded.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-right">{user.interactions.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-right">{user.acceptanceRate.toFixed(1)}%</td>
                      <td className="py-3">
                        <div className="flex gap-1 flex-wrap">
                          {user.usedAgent && <Badge variant="default">Agent</Badge>}
                          {user.usedCodingAgent && <Badge variant="default">Coding Agent</Badge>}
                          {user.usedChat && <Badge variant="secondary">Chat</Badge>}
                          {user.usedCli && <Badge variant="success">CLI</Badge>}
                          {user.usedCodeReviewActive && <Badge variant="warning">Review (Active)</Badge>}
                          {!user.usedCodeReviewActive && user.usedCodeReviewPassive && <Badge variant="secondary">Review (Passive)</Badge>}
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
