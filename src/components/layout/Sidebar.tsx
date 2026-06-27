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
  CreditCard,
  Monitor,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Brain,
  ShieldCheck,
  Receipt,
  DollarSign,
  Zap,
  TrendingUp,
} from "lucide-react";
import { useState, useEffect } from "react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  visKey: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: "Usage Analytics",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard, visKey: "overview" },
      { href: "/dashboard/code-generation", label: "Code Generation", icon: Code2, visKey: "codeGeneration" },
      { href: "/dashboard/chat-modes", label: "Copilot Features", icon: Sparkles, visKey: "chatModes" },
      { href: "/dashboard/adoption-cohorts", label: "AI Adoption", icon: TrendingUp, visKey: "adoptionCohorts" },
      { href: "/dashboard/models", label: "Model Statistics", icon: Brain, visKey: "models" },
    ],
  },
  {
    label: "Developer Activity",
    items: [
      { href: "/dashboard/cli", label: "CLI Analytics", icon: Terminal, visKey: "cli" },
      { href: "/dashboard/ide-languages", label: "IDE & Languages", icon: Monitor, visKey: "ideLanguages" },
      { href: "/dashboard/pull-requests", label: "Pull Requests", icon: GitPullRequest, visKey: "pullRequests" },
    ],
  },
  {
    label: "People & Teams",
    items: [
      { href: "/dashboard/users", label: "User Explorer", icon: UserSearch, visKey: "users" },
      { href: "/dashboard/teams", label: "Team Analytics", icon: Users, visKey: "teams" },
      { href: "/dashboard/seats", label: "Seat Management", icon: CreditCard, visKey: "seats" },
    ],
  },
  {
    label: "Security",
    items: [
      { href: "/dashboard/security", label: "Security", icon: ShieldCheck, visKey: "security" },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/dashboard/billing", label: "Billing", icon: Receipt, visKey: "billing" },
      { href: "/dashboard/billing-usage", label: "Metered Usage", icon: DollarSign, visKey: "billingUsage" },
      { href: "/dashboard/billing-premium", label: "AI Credits", icon: Zap, visKey: "billingPremium" },
    ],
  },
];

type PageVisibility = Record<string, boolean>;

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [pageVisibility, setPageVisibility] = useState<PageVisibility>({});
  const [enterpriseLabel, setEnterpriseLabel] = useState<string>("Enterprise Dashboard");

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((config) => {
        if (config?.pageVisibility) {
          setPageVisibility(config.pageVisibility);
        }
      })
      .catch(() => {}); // Default to showing all if config unavailable
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

  const isItemVisible = (item: NavItem) => {
    if (Object.keys(pageVisibility).length === 0) return true;
    return pageVisibility[item.visKey] !== false;
  };

  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(isItemVisible),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <aside
      className={cn(
        "min-h-0 flex flex-col border-r bg-[hsl(var(--card))] transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--primary))] text-white">
          <Sparkles className="h-4 w-4" />
        </div>
        {!collapsed && (
          <div className="flex flex-col">
            <span className="text-sm font-bold">Copilot Metrics</span>
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]" title={enterpriseLabel}>{enterpriseLabel}</span>
          </div>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto p-3">
        {visibleGroups.map((group, groupIndex) => (
          <div key={group.label} className={cn("mb-1", groupIndex === 0 ? "mt-0" : "mt-4")}>
            {!collapsed && (
              <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                {group.label}
              </div>
            )}
            <div className="space-y-1">
              {group.items.map((item) => {
                const isActive =
                  item.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-lg py-2.5 text-sm font-medium transition-colors",
                      isActive
                        ? "border-l-2 border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 pl-[10px] pr-3 text-[hsl(var(--primary))]"
                        : "px-3 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
                    )}
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className="h-5 w-5 shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="border-t p-3">
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] transition-colors"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed && <span className="ml-2">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
