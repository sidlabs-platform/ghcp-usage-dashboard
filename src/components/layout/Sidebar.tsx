"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Code2,
  Terminal,
  GitPullRequest,
  Users,
  UserSearch,
  KeyRound,
  Monitor,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Brain,
  ShieldCheck,
  Receipt,
  DollarSign,
  Zap,
  TrendingUp,
  Activity,
  ScrollText,
  AppWindow,
  Cpu,
  BarChart2,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useSidebar } from "@/components/layout/SidebarContext";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  visKey: string;
}

interface NavDestination {
  id: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** When set, the destination is a direct link with no sub-items. */
  href?: string;
  visKey?: string;
  items?: NavItem[];
}

/**
 * Six question-shaped top-level destinations (issue #95).
 * All 22 existing routes remain reachable as sub-items — no URL is broken.
 */
const destinations: NavDestination[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    href: "/dashboard",
    visKey: "overview",
  },
  {
    id: "usage",
    label: "Usage",
    icon: BarChart2,
    items: [
      { href: "/dashboard/ai-usage",           label: "Activity",         icon: Activity,       visKey: "aiUsage" },
      { href: "/dashboard/code-generation",     label: "Code",             icon: Code2,          visKey: "codeGeneration" },
      { href: "/dashboard/chat-modes",          label: "Features",         icon: Sparkles,       visKey: "chatModes" },
      { href: "/dashboard/models",              label: "Model Statistics", icon: Brain,          visKey: "models" },
      { href: "/dashboard/cli",                 label: "CLI Analytics",    icon: Terminal,       visKey: "cli" },
      { href: "/dashboard/ide-languages",       label: "IDE & Languages",  icon: Monitor,        visKey: "ideLanguages" },
      { href: "/dashboard/copilot-app",         label: "Copilot App",      icon: AppWindow,      visKey: "copilotApp" },
      { href: "/dashboard/pull-requests",       label: "Pull Requests",    icon: GitPullRequest, visKey: "pullRequests" },
      { href: "/dashboard/adoption-cohorts",    label: "AI Adoption",      icon: TrendingUp,     visKey: "adoptionCohorts" },
    ],
  },
  {
    id: "people",
    label: "People",
    icon: Users,
    items: [
      { href: "/dashboard/users",               label: "User Explorer",    icon: UserSearch,     visKey: "users" },
      { href: "/dashboard/teams",               label: "Teams",            icon: Users,          visKey: "teams" },
      // KeyRound replaces CreditCard — one icon per concept (issue #103 item 3)
      { href: "/dashboard/seats",               label: "Seat Management",  icon: KeyRound,       visKey: "seats" },
    ],
  },
  {
    id: "cost",
    label: "Cost & Licensing",
    icon: DollarSign,
    items: [
      { href: "/dashboard/billing",             label: "Billing",          icon: Receipt,        visKey: "billing" },
      { href: "/dashboard/billing-premium",     label: "AI Credits",       icon: Zap,            visKey: "billingPremium" },
      { href: "/dashboard/token-usage",         label: "Tokens",           icon: Cpu,            visKey: "tokenUsage" },
      { href: "/dashboard/billing-usage",       label: "Metered Usage",    icon: DollarSign,     visKey: "billingUsage" },
      { href: "/dashboard/license-reconciliation", label: "Reconciliation", icon: ScrollText,    visKey: "licenseReconciliation" },
      { href: "/dashboard/ai-credits-users",    label: "Credits by User",  icon: Zap,            visKey: "aiCreditsUsers" },
    ],
  },
  {
    id: "security",
    label: "Security",
    icon: ShieldCheck,
    href: "/dashboard/security",
    visKey: "security",
  },
  // Settings & Sync — deferred: no existing routes yet.
  // Add items here when /dashboard/settings is created (issue #95).
];

type PageVisibility = Record<string, boolean>;

/** Main application sidebar, supporting persistent desktop and off-canvas mobile modes. */
export function Sidebar() {
  const pathname = usePathname();
  const { isOpen, close, isCollapsed, setCollapsed } = useSidebar();
  const [pageVisibility, setPageVisibility] = useState<PageVisibility>({});
  const [enterpriseLabel, setEnterpriseLabel] = useState<string>("Enterprise Dashboard");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    // Start all accordion groups expanded so all items are visible on first render.
    // Users can collapse individual groups to declutter.
    () => new Set(destinations.filter((d) => d.items).map((d) => d.id)),
  );

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((config) => {
        if (config?.pageVisibility) setPageVisibility(config.pageVisibility);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/filters")
      .then((r) => r.json())
      .then((data: { enterprises?: { slug: string; displayName: string }[] }) => {
        const list = data?.enterprises ?? [];
        if (list.length === 1) {
          setEnterpriseLabel(list[0].displayName || list[0].slug);
        } else if (list.length > 1) {
          setEnterpriseLabel(`${list.length} enterprises`);
        }
      })
      .catch(() => {});
  }, []);

  const isItemVisible = useCallback(
    (visKey: string) => {
      if (Object.keys(pageVisibility).length === 0) return true;
      return pageVisibility[visKey] !== false;
    },
    [pageVisibility],
  );

  const isItemActive = useCallback(
    (href: string) =>
      href === "/dashboard"
        ? pathname === "/dashboard"
        : pathname === href || pathname.startsWith(href + "/"),
    [pathname],
  );

  const isDestinationActive = useCallback(
    (dest: NavDestination): boolean => {
      if (dest.href) return isItemActive(dest.href);
      return dest.items?.some((item) => isItemActive(item.href)) ?? false;
    },
    [isItemActive],
  );

  // Auto-expand the group that contains the active route.
  useEffect(() => {
    for (const dest of destinations) {
      if (dest.items?.some((item) => isItemActive(item.href))) {
        setExpandedGroups((prev) => {
          if (prev.has(dest.id)) return prev;
          return new Set([...prev, dest.id]);
        });
      }
    }
  }, [pathname, isItemActive]);

  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Filter destinations and sub-items by pageVisibility config.
  const visibleDestinations = destinations
    .map((dest): NavDestination | null => {
      if (dest.href) {
        if (dest.visKey && !isItemVisible(dest.visKey)) return null;
        return dest;
      }
      const items = (dest.items ?? []).filter((item) => isItemVisible(item.visKey));
      if (items.length === 0) return null;
      return { ...dest, items };
    })
    .filter((d): d is NavDestination => d !== null);

  return (
    <aside
      id="sidebar-nav"
      aria-label="Main navigation"
      className={cn(
        "flex flex-col border-r bg-[hsl(var(--card))] transition-all duration-300",
        // Desktop: persistent, respects isCollapsed
        "md:relative md:flex md:min-h-0",
        isCollapsed ? "md:w-16" : "md:w-64",
        // Mobile: off-canvas drawer (scrim is rendered by DashboardShell)
        "fixed inset-y-0 left-0 z-40 h-full w-64 md:static md:z-auto",
        isOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full md:translate-x-0",
      )}
    >
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary))] text-white">
          <Sparkles className="h-4 w-4" />
        </div>
        {!isCollapsed && (
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-bold">Copilot Metrics</span>
            <span
              className="truncate text-[10px] text-[hsl(var(--muted-foreground))]"
              title={enterpriseLabel}
            >
              {enterpriseLabel}
            </span>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2" aria-label="Site navigation">
        <ul role="list" className="space-y-0.5">
          {visibleDestinations.map((dest) => {
            const active = isDestinationActive(dest);
            const expanded = expandedGroups.has(dest.id);

            if (dest.href) {
              // Standalone link (Overview, Security)
              return (
                <li key={dest.id}>
                  <Link
                    href={dest.href}
                    onClick={() => close()}
                    title={isCollapsed ? dest.label : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg py-2.5 text-sm font-semibold transition-colors",
                      active
                        ? "border-l-2 border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 pl-[10px] pr-3 text-[hsl(var(--primary))]"
                        : "px-3 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]",
                    )}
                  >
                    <dest.icon className="h-5 w-5 shrink-0" />
                    {!isCollapsed && <span>{dest.label}</span>}
                  </Link>
                </li>
              );
            }

            // Expandable group destination
            return (
              <li key={dest.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (isCollapsed) {
                      // Uncollapse sidebar so sub-items become visible
                      setCollapsed(false);
                      setExpandedGroups((prev) => new Set([...prev, dest.id]));
                    } else {
                      toggleGroup(dest.id);
                    }
                  }}
                  title={isCollapsed ? dest.label : undefined}
                  aria-expanded={expanded}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg py-2.5 text-sm font-semibold transition-colors",
                    active && !expanded
                      ? "bg-[hsl(var(--primary))]/5 text-[hsl(var(--primary))]"
                      : "text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]",
                    isCollapsed ? "justify-center px-0" : "px-3",
                  )}
                >
                  <dest.icon
                    className={cn("h-5 w-5 shrink-0", active && "text-[hsl(var(--primary))]")}
                  />
                  {!isCollapsed && (
                    <>
                      <span className="flex-1 text-left">{dest.label}</span>
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-[hsl(var(--muted-foreground))] transition-transform duration-200",
                          expanded && "rotate-180",
                        )}
                      />
                    </>
                  )}
                </button>

                {/* Sub-items — visible only when group is expanded and sidebar is full-width */}
                {!isCollapsed && expanded && (
                  <ul
                    role="list"
                    className="mt-0.5 ml-3 space-y-0.5 border-l border-[hsl(var(--border))] pl-3"
                  >
                    {dest.items?.map((item) => {
                      const itemActive = isItemActive(item.href);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => close()}
                            className={cn(
                              "flex items-center gap-2.5 rounded-md py-2 px-2 text-sm transition-colors",
                              itemActive
                                ? "border-l-2 border-[hsl(var(--primary))] pl-[6px] font-medium text-[hsl(var(--primary))] bg-[hsl(var(--primary))]/5"
                                : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]",
                            )}
                          >
                            <item.icon className="h-4 w-4 shrink-0" />
                            <span>{item.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Desktop collapse toggle */}
      <div className="hidden border-t p-2 md:block">
        <button
          type="button"
          onClick={() => setCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isCollapsed}
          className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] transition-colors"
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!isCollapsed && <span className="ml-2">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

