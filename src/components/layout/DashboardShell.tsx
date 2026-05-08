"use client";

import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

/** Client-side shell that activates global keyboard shortcuts for the dashboard. */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  useKeyboardShortcuts();
  return <>{children}</>;
}
