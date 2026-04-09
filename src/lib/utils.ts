import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function formatDelta(current: number, previous: number): { value: string; positive: boolean } {
  if (previous === 0) return { value: "N/A", positive: true };
  const delta = ((current - previous) / previous) * 100;
  return {
    value: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
    positive: delta >= 0,
  };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

export function getDateRange(days: number): { start: string; end: string } {
  const end = new Date();
  end.setDate(end.getDate() - 1); // yesterday (latest available)
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return {
    start: start.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0],
  };
}

export function datesBetween(startDay: string, endDay: string): string[] {
  const dates: string[] = [];
  const current = new Date(startDay);
  const end = new Date(endDay);
  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}
