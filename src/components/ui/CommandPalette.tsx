"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";

interface SearchEntry {
  href: string;
  label: string;
  description: string;
  keywords: string[];
  section: string;
}

const SEARCH_INDEX: SearchEntry[] = [
  {
    href: "/dashboard",
    label: "Overview",
    description: "High-level adoption and utilization metrics",
    keywords: ["DAU", "WAU", "MAU", "adoption", "license", "utilization", "acceptance rate", "active users"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/code-generation",
    label: "Code Generation",
    description: "Lines of code suggested and accepted by Copilot",
    keywords: ["LoC", "lines of code", "suggested", "accepted", "completions", "code gen", "acceptance"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/chat-modes",
    label: "Copilot Features",
    description: "Usage across chat, agent, edit, and other Copilot features",
    keywords: ["chat", "agent", "edit", "plan", "ask", "feature", "adoption", "interactions"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/adoption-cohorts",
    label: "AI Adoption Cohorts",
    description: "AI adoption maturity phases — code first, agent first, multi-agent",
    keywords: ["adoption", "cohort", "phase", "maturity", "code first", "agent first", "multi-agent"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/models",
    label: "Model Statistics",
    description: "AI model usage and distribution across features",
    keywords: ["model", "GPT", "Claude", "AI", "usage", "distribution"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/cli",
    label: "CLI Analytics",
    description: "Command-line Copilot sessions and token usage",
    keywords: ["CLI", "terminal", "command line", "sessions", "tokens"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/ide-languages",
    label: "IDE & Languages",
    description: "Editor and programming language breakdown",
    keywords: ["IDE", "VS Code", "JetBrains", "Neovim", "Xcode", "language", "editor"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/pull-requests",
    label: "Pull Requests",
    description: "Copilot-authored PRs, merge rates, and review times",
    keywords: ["PR", "pull request", "merge", "review", "authored", "merge time"],
    section: "Dashboard",
  },
  {
    href: "/dashboard/teams",
    label: "Team Analytics",
    description: "Team-level leaderboard and adoption metrics",
    keywords: ["team", "leaderboard", "members", "adoption"],
    section: "Analytics",
  },
  {
    href: "/dashboard/users",
    label: "User Explorer",
    description: "Individual developer activity and usage details",
    keywords: ["user", "developer", "individual", "activity"],
    section: "Analytics",
  },
  {
    href: "/dashboard/seats",
    label: "Seat Management",
    description: "License allocation and inactive seat identification",
    keywords: ["seat", "license", "inactive", "utilization", "allocation"],
    section: "Management",
  },
  {
    href: "/dashboard/security",
    label: "Security",
    description: "Security scanning alerts and vulnerability tracking",
    keywords: ["security", "scanning", "alerts", "vulnerabilities", "Dependabot", "secret", "autofix"],
    section: "Management",
  },
  {
    href: "/dashboard/billing",
    label: "Billing",
    description: "Cost overview by product and organization",
    keywords: ["billing", "cost", "spend", "overview", "product"],
    section: "Billing",
  },
  {
    href: "/dashboard/billing-usage",
    label: "Metered Usage",
    description: "Metered usage breakdown by SKU, cost center, and repository",
    keywords: ["metered", "usage", "SKU", "cost center", "repository", "charge"],
    section: "Billing",
  },
  {
    href: "/dashboard/billing-premium",
    label: "AI Credits",
    description: "Premium model quota and over-quota request tracking",
    keywords: ["premium", "quota", "model", "requests", "over quota"],
    section: "Billing",
  },
  {
    href: "/dashboard/license-reconciliation",
    label: "License & Credits",
    description: "Per-user license lifecycle, seat cost, and AI-credit allocation vs. consumption",
    keywords: ["license", "reconciliation", "seat cost", "aic", "allocation", "utilization", "budget", "cost of ownership"],
    section: "Billing",
  },
  {
    href: "/dashboard/ai-credits-users",
    label: "AI Credits by User",
    description: "Sortable user-level AI credit consumption",
    keywords: ["ai credits", "user", "billing", "consumption", "usage"],
    section: "Billing",
  },
];

function matchesQuery(entry: SearchEntry, query: string): boolean {
  const q = query.toLowerCase();
  if (entry.label.toLowerCase().includes(q)) return true;
  if (entry.description.toLowerCase().includes(q)) return true;
  return entry.keywords.some((kw) => kw.toLowerCase().includes(q));
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const filtered = useMemo(() => {
    if (!query.trim()) return SEARCH_INDEX;
    return SEARCH_INDEX.filter((entry) => matchesQuery(entry, query.trim()));
  }, [query]);

  // Group by section, preserving order
  const grouped = useMemo(() => {
    const map = new Map<string, SearchEntry[]>();
    for (const entry of filtered) {
      const group = map.get(entry.section) ?? [];
      group.push(entry);
      map.set(entry.section, group);
    }
    return map;
  }, [filtered]);

  // Flat list for keyboard navigation indexing
  const flatList = useMemo(() => filtered, [filtered]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered]);

  // Global ⌘K / Ctrl+K listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Auto-focus input when opened; reset query when closed
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Small delay to ensure the modal is rendered before focusing
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const navigate = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (flatList.length > 0) {
            setSelectedIndex((i) => (i + 1) % flatList.length);
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (flatList.length > 0) {
            setSelectedIndex((i) => (i - 1 + flatList.length) % flatList.length);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (flatList[selectedIndex]) {
            navigate(flatList[selectedIndex].href);
          }
          break;
        case "Escape":
          e.preventDefault();
          setOpen(false);
          break;
      }
    },
    [flatList, selectedIndex, navigate]
  );

  if (!open) return null;

  // Build rendered groups with a running flat index counter
  let flatIndex = 0;
  const sections: React.ReactNode[] = [];
  for (const [section, entries] of grouped) {
    const items: React.ReactNode[] = [];
    for (const entry of entries) {
      const idx = flatIndex++;
      items.push(
        <button
          key={entry.href}
          data-index={idx}
          onClick={() => navigate(entry.href)}
          onMouseEnter={() => setSelectedIndex(idx)}
          className="w-full text-left px-3 py-2 rounded-md flex flex-col gap-0.5 transition-colors"
          style={{
            backgroundColor: idx === selectedIndex ? "hsl(var(--primary) / 0.1)" : "transparent",
            color: "hsl(var(--foreground))",
          }}
        >
          <span className="text-sm font-medium">{entry.label}</span>
          <span
            className="text-xs"
            style={{ color: "hsl(var(--muted-foreground))" }}
          >
            {entry.description}
          </span>
        </button>
      );
    }
    sections.push(
      <div key={section} className="mb-2">
        <div
          className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"
          style={{ color: "hsl(var(--muted-foreground))" }}
        >
          {section}
        </div>
        {items}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      style={{ backgroundColor: "hsl(var(--background) / 0.6)", backdropFilter: "blur(4px)" }}
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Search dashboard pages"
        style={{
          backgroundColor: "hsl(var(--background))",
          borderColor: "hsl(var(--border))",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div
          className="flex items-center border-b px-4"
          style={{ borderColor: "hsl(var(--border))" }}
        >
          <svg
            className="mr-2 h-4 w-4 shrink-0"
            style={{ color: "hsl(var(--muted-foreground))" }}
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search pages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-[hsl(var(--muted-foreground))]"
            style={{ color: "hsl(var(--foreground))" }}
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto p-2">
          {flatList.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-sm"
              style={{ color: "hsl(var(--muted-foreground))" }}
            >
              No results found.
            </div>
          ) : (
            sections
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between border-t px-4 py-2 text-xs"
          style={{
            borderColor: "hsl(var(--border))",
            color: "hsl(var(--muted-foreground))",
          }}
        >
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Open</span>
            <span>Esc Close</span>
          </div>
          <kbd
            className="rounded border px-1.5 py-0.5 text-xs font-mono font-semibold"
            style={{
              borderColor: "hsl(var(--border))",
              backgroundColor: "hsl(var(--muted))",
              color: "hsl(var(--foreground))",
            }}
          >
            ⌘K
          </kbd>
        </div>
      </div>
    </div>
  );
}
