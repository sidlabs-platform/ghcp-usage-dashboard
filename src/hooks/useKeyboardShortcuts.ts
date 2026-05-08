"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const PAGE_SHORTCUTS: Record<string, string> = {
  "1": "/dashboard",
  "2": "/dashboard/code-generation",
  "3": "/dashboard/chat-modes",
  "4": "/dashboard/models",
  "5": "/dashboard/cli",
  "6": "/dashboard/pull-requests",
  "7": "/dashboard/teams",
  "8": "/dashboard/users",
  "9": "/dashboard/security",
};

/** Global keyboard shortcuts for dashboard navigation. Number keys 1-9 jump to pages. */
export function useKeyboardShortcuts() {
  const router = useRouter();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      // Number keys (without modifiers) → page shortcuts
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && PAGE_SHORTCUTS[e.key]) {
        router.push(PAGE_SHORTCUTS[e.key]);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [router]);
}
