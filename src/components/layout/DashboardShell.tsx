"use client";

import { useEffect } from "react";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SidebarProvider, useSidebar } from "./SidebarContext";

/** Semi-transparent scrim shown behind the off-canvas drawer below md. */
function SidebarScrim() {
  const { isOpen, close } = useSidebar();
  if (!isOpen) return null;
  return (
    // aria-hidden: purely presentational overlay; Escape key handler below closes the drawer
    <div
      aria-hidden="true"
      className="fixed inset-0 z-30 bg-black/50 md:hidden"
      onClick={close}
    />
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  useKeyboardShortcuts();
  const { isOpen, close } = useSidebar();

  // Close the off-canvas drawer on Escape.
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close]);

  return (
    <>
      <SidebarScrim />
      {children}
    </>
  );
}

/**
 * Client-side dashboard shell.
 *
 * Responsibilities:
 * - Activates global keyboard shortcuts via `useKeyboardShortcuts`.
 * - Provides `SidebarProvider` so both `Header` (hamburger) and `Sidebar`
 *   (drawer open/collapse state) can share state without prop-drilling.
 * - Renders the translucent scrim behind the off-canvas drawer below `md`.
 * - Closes the drawer on `Escape`.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <ShellInner>{children}</ShellInner>
    </SidebarProvider>
  );
}
