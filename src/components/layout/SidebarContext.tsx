"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface SidebarContextValue {
  /** Whether the off-canvas drawer is open (relevant below md breakpoint). */
  isOpen: boolean;
  /** Open the off-canvas drawer. */
  open: () => void;
  /** Close the off-canvas drawer. */
  close: () => void;
  /** Toggle the off-canvas drawer. */
  toggle: () => void;
  /** Whether the persistent desktop sidebar is collapsed to icon-only mode. */
  isCollapsed: boolean;
  /** Update the collapsed preference (persisted to localStorage). */
  setCollapsed: (value: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

/**
 * Consume sidebar open/collapsed state from any child component.
 *
 * Must be called within a `SidebarProvider` tree (already provided by
 * `DashboardShell`). The Sidebar component can consume this without any
 * changes to the shell — import `useSidebar` and call it.
 */
export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside SidebarProvider");
  return ctx;
}

/**
 * Provides off-canvas open state and desktop collapsed state for the sidebar.
 *
 * ## API consumed by Sidebar.tsx
 * ```ts
 * import { useSidebar } from "@/components/layout/SidebarContext";
 *
 * const { isOpen, close, isCollapsed, setCollapsed } = useSidebar();
 * ```
 * - `isOpen` — render the aside as visible off-canvas drawer on mobile when true
 * - `close` — call on overlay click, Escape key, or internal close button
 * - `isCollapsed` — render the aside in icon-only (w-16) mode on desktop
 * - `setCollapsed(bool)` — call from the sidebar collapse toggle button
 *
 * The `<aside>` should have:
 * - `id="sidebar-nav"` (referenced by the hamburger `aria-controls`)
 * - `aria-hidden={!isOpen}` on mobile (added/removed by responsive class)
 * - Focus trap while `isOpen && window.innerWidth < 768`
 */
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCollapsed, setIsCollapsedState] = useState(false);
  const pathname = usePathname();

  // Restore collapsed preference from localStorage (desktop only).
  useEffect(() => {
    try {
      const stored = localStorage.getItem("sidebar:collapsed");
      if (stored === "true") setIsCollapsedState(true);
    } catch {
      // localStorage unavailable (SSR/incognito)
    }
  }, []);

  // Close the off-canvas drawer whenever the route changes.
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  const setCollapsed = useCallback((value: boolean) => {
    setIsCollapsedState(value);
    try {
      localStorage.setItem("sidebar:collapsed", String(value));
    } catch {
      // ignore
    }
  }, []);

  return (
    <SidebarContext.Provider value={{ isOpen, open, close, toggle, isCollapsed, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}
