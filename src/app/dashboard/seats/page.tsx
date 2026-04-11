"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreditCard, UserCheck, UserX, Percent } from "lucide-react";
import { useTableSort } from "@/hooks/useTableSort";
import { SortableHeader } from "@/components/tables/SortableHeader";

interface SeatRow {
  org_slug: string;
  user_login: string;
  user_id: number;
  plan_type: string;
  last_activity_at: string | null;
  last_activity_editor: string | null;
  assigning_team_slug: string | null;
  assigning_team_name: string | null;
  pending_cancellation_date: string | null;
  created_at: string;
  avatar_url: string | null;
}

interface SeatStats {
  total: number;
  active30d: number;
  inactive30d: number;
  pendingCancellation: number;
}

interface SeatsData {
  seats: SeatRow[];
  stats: SeatStats;
  utilization: number;
}

function daysAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${diff}d ago`;
}

export default function SeatsPage() {
  const [data, setData] = useState<SeatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactiveOnly, setShowInactiveOnly] = useState(false);

  useEffect(() => {
    fetch("/api/seats")
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
        <PageHeader title="Seat Management" description="Copilot license allocation and utilization" />
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
        <PageHeader title="Seat Management" description="Copilot license allocation and utilization" />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString();

  const displayedSeats = showInactiveOnly
    ? data.seats.filter((s) => !s.last_activity_at || s.last_activity_at < cutoff)
    : data.seats;

  // Enrich seats with a sortable status rank: Active=0, Pending Cancel=1, Inactive=2
  const enrichedSeats = displayedSeats.map((s) => {
    const isActive = s.last_activity_at && s.last_activity_at >= cutoff;
    const isPending = !!s.pending_cancellation_date;
    const statusRank = isPending ? 1 : isActive ? 0 : 2;
    return { ...s, statusRank, _lastActivity: s.last_activity_at };
  });

  type SeatSortField = "user_login" | "org_slug" | "plan_type" | "_lastActivity" | "last_activity_editor" | "statusRank";
  const { sortedData: sortedSeats, sortField: seatSortField, sortAsc: seatSortAsc, handleSort: handleSeatSort } = useTableSort(enrichedSeats, "_lastActivity" as SeatSortField);

  return (
    <div>
      <PageHeader
        title="Seat Management"
        description="Copilot license allocation and utilization"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="Total Seats"
          value={data.stats.total}
          icon={<CreditCard className="h-4 w-4" />}
          subtitle="Assigned licenses"
        />
        <MetricCard
          title="Active (30d)"
          value={data.stats.active30d}
          icon={<UserCheck className="h-4 w-4" />}
          subtitle="Used in last 30 days"
        />
        <MetricCard
          title="Inactive (30d)"
          value={data.stats.inactive30d}
          icon={<UserX className="h-4 w-4" />}
          subtitle={`${data.stats.pendingCancellation} pending cancellation`}
        />
        <MetricCard
          title="Utilization"
          value={data.utilization}
          format="percent"
          icon={<Percent className="h-4 w-4" />}
          subtitle="Active / total seats"
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{showInactiveOnly ? "Inactive Seats" : "All Seats"}</CardTitle>
            <button
              onClick={() => setShowInactiveOnly(!showInactiveOnly)}
              className="text-sm px-3 py-1.5 rounded-md border hover:bg-[hsl(var(--muted))]"
            >
              {showInactiveOnly ? "Show All" : "Show Inactive Only"}
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {displayedSeats.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
              {data.seats.length === 0 ? "No seat data available. Sync seats to populate." : "No inactive seats found."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                    <SortableHeader label="User" field={"user_login" as SeatSortField} sortField={seatSortField} sortAsc={seatSortAsc} onSort={handleSeatSort} />
                    <SortableHeader label="Org" field={"org_slug" as SeatSortField} sortField={seatSortField} sortAsc={seatSortAsc} onSort={handleSeatSort} />
                    <SortableHeader label="Plan" field={"plan_type" as SeatSortField} sortField={seatSortField} sortAsc={seatSortAsc} onSort={handleSeatSort} />
                    <SortableHeader label="Last Activity" field={"_lastActivity" as SeatSortField} sortField={seatSortField} sortAsc={seatSortAsc} onSort={handleSeatSort} />
                    <SortableHeader label="Editor" field={"last_activity_editor" as SeatSortField} sortField={seatSortField} sortAsc={seatSortAsc} onSort={handleSeatSort} />
                    <SortableHeader label="Status" field={"statusRank" as SeatSortField} sortField={seatSortField} sortAsc={seatSortAsc} onSort={handleSeatSort} last />
                  </tr>
                </thead>
                <tbody>
                  {sortedSeats.map((seat) => {
                    const isActive = seat.last_activity_at && seat.last_activity_at >= cutoff;
                    const isPending = !!seat.pending_cancellation_date;
                    return (
                      <tr key={`${seat.org_slug}-${seat.user_login}`} className="border-b last:border-0">
                        <td className="py-3 pr-4 font-medium">{seat.user_login}</td>
                        <td className="py-3 pr-4">{seat.org_slug}</td>
                        <td className="py-3 pr-4">{seat.plan_type}</td>
                        <td className="py-3 pr-4">{daysAgo(seat.last_activity_at)}</td>
                        <td className="py-3 pr-4">{seat.last_activity_editor ?? "—"}</td>
                        <td className="py-3">
                          {isPending ? (
                            <Badge variant="warning">Pending Cancel</Badge>
                          ) : isActive ? (
                            <Badge variant="success">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
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
