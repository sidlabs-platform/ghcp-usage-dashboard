"use client";

import { Sun, Moon, RefreshCw, CheckCircle2, Clock } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DATE_PRESETS } from "@/lib/constants";
import { useDateRange } from "@/contexts/DateRangeContext";
import { cn } from "@/lib/utils";

export function Header() {
  const queryClient = useQueryClient();
  const [dark, setDark] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [autoSyncInfo, setAutoSyncInfo] = useState<{ enabled: boolean; utcTime: string; nextRunAt: string | null } | null>(null);
  const { mode, days: selectedDays, startDate, endDate, setDays: setSelectedDays } = useDateRange();

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const isDark = stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  // Check if sync is already running on mount
  useEffect(() => {
    fetch("/api/sync")
      .then((res) => res.json())
      .then((data) => {
        if (data.autoSync) setAutoSyncInfo(data.autoSync);
        if (data.syncInProgress) {
          setSyncing(true);
          pollSyncStatus();
        } else if (data.status?.length > 0) {
          const total = data.status.reduce((s: number, r: { days_synced: number }) => s + r.days_synced, 0);
          setSyncStatus(`${total} days synced`);
        }
      })
      .catch(() => {});
  }, []);

  const pollSyncStatus = useCallback(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/sync");
        const data = await res.json();
        if (!data.syncInProgress) {
          clearInterval(interval);
          setSyncing(false);
          const total = data.status?.reduce((s: number, r: { days_synced: number }) => s + r.days_synced, 0) || 0;
          setSyncStatus(`${total} days synced`);
          // Invalidate all queries to refresh data
          queryClient.invalidateQueries();
        } else {
          const total = data.status?.reduce((s: number, r: { days_synced: number }) => s + r.days_synced, 0) || 0;
          setSyncStatus(`Syncing... ${total} days`);
        }
      } catch {
        // ignore polling errors
      }
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const toggleTheme = () => {
    const newDark = !dark;
    setDark(newDark);
    document.documentElement.classList.toggle("dark", newDark);
    localStorage.setItem("theme", newDark ? "dark" : "light");
  };

  const triggerSync = async () => {
    setSyncing(true);
    setSyncStatus("Starting sync...");
    try {
      await fetch("/api/sync", { method: "POST" });
      pollSyncStatus();
    } catch {
      setSyncing(false);
      setSyncStatus("Sync failed");
    }
  };

  return (
    <header className="flex h-16 items-center justify-between border-b bg-[hsl(var(--card))] px-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">GitHub Copilot Usage Dashboard</h1>
        {syncStatus && (
          <Badge variant={syncing ? "secondary" : "success"} className="text-xs">
            {!syncing && <CheckCircle2 className="h-3 w-3 mr-1" />}
            {syncing && <RefreshCw className="h-3 w-3 mr-1 animate-spin" />}
            {syncStatus}
          </Badge>
        )}
        {autoSyncInfo?.enabled && (
          <Badge variant="outline" className="text-xs">
            <Clock className="h-3 w-3 mr-1" />
            Auto-sync {autoSyncInfo.utcTime} UTC
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Date range presets */}
        <div className="flex items-center rounded-lg bg-[hsl(var(--muted))] p-1">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.days}
              onClick={() => setSelectedDays(preset.days)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                mode === "preset" && selectedDays === preset.days
                  ? "bg-[hsl(var(--background))] text-[hsl(var(--foreground))] shadow-sm"
                  : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {mode === "custom" && (
          <Badge variant="outline" className="text-xs">
            {startDate} — {endDate}
          </Badge>
        )}

        {/* Sync button */}
        <Button variant="outline" size="sm" onClick={triggerSync} disabled={syncing}>
          <RefreshCw className={cn("h-4 w-4 mr-1", syncing && "animate-spin")} />
          {syncing ? "Syncing..." : "Sync"}
        </Button>

        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
