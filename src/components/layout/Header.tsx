"use client";

import {
  Sun,
  Moon,
  RefreshCw,
  CheckCircle2,
  Clock,
  Menu,
  AlertCircle,
} from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DATE_PRESETS } from "@/lib/constants";
import { useDateRange } from "@/contexts/DateRangeContext";
import { MonthSelector } from "@/components/filters/MonthSelector";
import { CustomRangeFilter } from "@/components/filters/CustomRangeFilter";
import { useSidebar } from "./SidebarContext";
import { cn } from "@/lib/utils";

/** Poll every 5 s while a sync is in progress (user-initiated, short-lived). */
const POLL_INTERVAL_MS = 5_000;
/** Stop polling and show an error after this many consecutive fetch failures. */
const MAX_POLL_FAILURES = 5;

/** Top navigation bar: branding, sync status, date controls, theme toggle. */
export function Header() {
  const queryClient = useQueryClient();
  const [dark, setDark] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [syncError, setSyncError] = useState(false);
  const [autoSyncInfo, setAutoSyncInfo] = useState<{
    enabled: boolean;
    utcTime: string;
    nextRunAt: string | null;
  } | null>(null);

  const { mode, days: selectedDays, startDate, endDate, setDays: setSelectedDays } =
    useDateRange();
  const { toggle: toggleSidebar, isOpen: sidebarIsOpen } = useSidebar();

  // Interval ref: cleared on unmount and on poll completion/failure so it
  // cannot fire after the component is gone (#102 interval leak fix).
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failureCountRef = useRef(0);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const isDark =
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  /** Clear the running poll interval and reset the failure counter. */
  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    failureCountRef.current = 0;
  }, []);

  // Ensure the interval is always cleared when the Header unmounts.
  useEffect(() => {
    return stopPolling;
  }, [stopPolling]);

  /**
   * Start (or restart) the sync-status poll.
   *
   * - 5 s cadence instead of 60 s: sync is a short-lived, user-triggered
   *   operation; fast feedback matters here.
   * - Stores the interval id in a ref: guaranteed cleanup on unmount.
   * - Bounded failure counter: surfaces an explicit error rather than spinning
   *   indefinitely when the backend is unreachable.
   */
  const pollSyncStatus = useCallback(() => {
    stopPolling();

    intervalRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/sync");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        failureCountRef.current = 0;

        if (!data.syncInProgress) {
          stopPolling();
          setSyncing(false);
          setSyncError(false);
          const total =
            data.status?.reduce(
              (s: number, r: { days_synced: number }) => s + r.days_synced,
              0
            ) ?? 0;
          setSyncStatus(`${total} days synced`);
          // Invalidate data queries (not config/filter metadata) so charts
          // refresh without a full page reload.
          queryClient.invalidateQueries();
        } else {
          const total =
            data.status?.reduce(
              (s: number, r: { days_synced: number }) => s + r.days_synced,
              0
            ) ?? 0;
          setSyncStatus(`Syncing… ${total} days`);
          setSyncError(false);
        }
      } catch {
        failureCountRef.current += 1;
        if (failureCountRef.current >= MAX_POLL_FAILURES) {
          stopPolling();
          setSyncing(false);
          setSyncError(true);
          setSyncStatus("Sync status unavailable");
        }
      }
    }, POLL_INTERVAL_MS);
  }, [queryClient, stopPolling]);

  // Check if a sync is already running when the header mounts.
  useEffect(() => {
    fetch("/api/sync")
      .then((res) => res.json())
      .then((data) => {
        if (data.autoSync) setAutoSyncInfo(data.autoSync);
        if (data.syncInProgress) {
          setSyncing(true);
          pollSyncStatus();
        } else if (data.status?.length > 0) {
          const total = data.status.reduce(
            (s: number, r: { days_synced: number }) => s + r.days_synced,
            0
          );
          setSyncStatus(`${total} days synced`);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = () => {
    const newDark = !dark;
    setDark(newDark);
    document.documentElement.classList.toggle("dark", newDark);
    localStorage.setItem("theme", newDark ? "dark" : "light");
  };

  const triggerSync = async () => {
    setSyncing(true);
    setSyncError(false);
    setSyncStatus("Starting sync...");
    try {
      await fetch("/api/sync", { method: "POST" });
      pollSyncStatus();
    } catch {
      setSyncing(false);
      setSyncError(true);
      setSyncStatus("Sync failed");
    }
  };

  return (
    <header className="border-b bg-[hsl(var(--card))] px-4 sm:px-6">
      {/* ── Row 1: hamburger + brand + status badges + sync + theme ── */}
      <div className="flex h-14 items-center justify-between gap-2">
        {/* Left: hamburger (mobile) + brand text + badges */}
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden shrink-0"
            onClick={toggleSidebar}
            aria-label="Open navigation menu"
            aria-controls="sidebar-nav"
            aria-expanded={sidebarIsOpen}
          >
            <Menu className="h-5 w-5" />
          </Button>

          {/* Brand: demoted to <p> so the PAGE title can own <h1> (#101) */}
          <p className="text-base font-semibold truncate hidden sm:block">
            GitHub Copilot Usage Dashboard
          </p>

          {/* Sync status badge — announced via aria-live region below */}
          {syncStatus && (
            <Badge
              variant={syncError ? "destructive" : syncing ? "secondary" : "success"}
              className="text-xs shrink-0"
            >
              {syncError ? (
                <AlertCircle className="h-3 w-3 mr-1" />
              ) : !syncing ? (
                <CheckCircle2 className="h-3 w-3 mr-1" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
              )}
              {syncStatus}
            </Badge>
          )}

          {autoSyncInfo?.enabled && (
            <Badge variant="outline" className="text-xs shrink-0 hidden lg:flex">
              <Clock className="h-3 w-3 mr-1" />
              Auto-sync {autoSyncInfo.utcTime} UTC
            </Badge>
          )}
        </div>

        {/* Right: Sync button + theme toggle */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={triggerSync}
            disabled={syncing}
          >
            <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
            <span className="ml-1 hidden sm:inline">
              {syncing ? "Syncing..." : "Sync"}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* ── Row 2: date range controls — wraps on small screens ── */}
      <div className="flex flex-wrap items-center gap-2 pb-3">
        {/* Desktop: pill row (md and up) */}
        <div className="hidden md:flex items-center rounded-lg bg-[hsl(var(--muted))] p-1">
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

        {/* Mobile: collapsed into a <select> (below md) */}
        <div className="md:hidden">
          <label htmlFor="date-preset-select" className="sr-only">
            Date range
          </label>
          <select
            id="date-preset-select"
            value={mode === "preset" ? String(selectedDays) : ""}
            onChange={(e) => {
              if (e.target.value) setSelectedDays(Number(e.target.value));
            }}
            className="rounded-md border bg-[hsl(var(--background))] px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          >
            {mode !== "preset" && <option value="">Custom range</option>}
            {DATE_PRESETS.map((preset) => (
              <option key={preset.days} value={String(preset.days)}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>

        {/* Month selector (participates in the same flex-wrap row) */}
        <MonthSelector />

        {/*
          Custom range. Lives here rather than in a per-page control so the app
          has exactly one date selector covering all three modes.
        */}
        <CustomRangeFilter />

        {/* Resolved bounds — the month selector shows a label, not dates */}
        {mode === "month" && (
          <Badge variant="outline" className="text-xs">
            {startDate} — {endDate}
          </Badge>
        )}
      </div>

      {/*
        Polite live region: announces sync state changes to screen readers
        without interrupting the user's current task (#101 live regions).
      */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {syncStatus}
      </div>
    </header>
  );
}
