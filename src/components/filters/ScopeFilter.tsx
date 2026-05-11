"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Building2, Users, ChevronDown, Search, X, Check, Shield } from "lucide-react";
import { useScope } from "@/contexts/ScopeContext";

export interface ScopeFilterProps {
  /** When true, only show organization filter (hide team dropdowns) */
  orgOnly?: boolean;
}

type ScopeMode = "none" | "enterprise" | "org";

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [ref, handler]);
}

interface DropdownProps {
  label: string;
  icon: React.ReactNode;
  items: { value: string; label: string; extra?: string }[];
  selected: string[];
  onChange: (selected: string[]) => void;
  searchable?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
}

function FilterDropdown({
  label,
  icon,
  items,
  selected,
  onChange,
  searchable = false,
  placeholder = "All",
  disabled = false,
  disabledReason,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => { setOpen(false); setSearch(""); }, []);
  useClickOutside(ref, close);

  useEffect(() => {
    if (open && searchable && searchRef.current) searchRef.current.focus();
  }, [open, searchable]);

  const allSelected = selected.length === 0;
  const toggle = (value: string) => {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };
  const selectAll = () => onChange([]);

  const filtered = searchable && search
    ? items.filter((i) => i.label.toLowerCase().includes(search.toLowerCase()))
    : items;

  const displayText = allSelected
    ? placeholder
    : selected.length === 1
      ? items.find((i) => i.value === selected[0])?.label ?? selected[0]
      : `${selected.length} selected`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
          disabled
            ? "opacity-40 cursor-not-allowed border-[hsl(var(--border))] bg-[hsl(var(--muted))]"
            : open
              ? "border-[hsl(var(--ring))] bg-[hsl(var(--background))]"
              : "border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:border-[hsl(var(--ring))]"
        )}
      >
        {icon}
        <span className="font-medium">{label}:</span>
        <span className={cn("max-w-[140px] truncate", allSelected ? "text-[hsl(var(--muted-foreground))]" : "")}>
          {displayText}
        </span>
        {!allSelected && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[hsl(var(--primary))] px-1.5 text-[10px] font-semibold text-[hsl(var(--primary-foreground))]">
            {selected.length}
          </span>
        )}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] shadow-lg">
          {searchable && (
            <div className="border-b border-[hsl(var(--border))] p-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-full rounded-md border border-[hsl(var(--border))] bg-transparent pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
                />
                {search && (
                  <button type="button" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="max-h-60 overflow-y-auto p-1.5">
            <button
              type="button"
              onClick={selectAll}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                allSelected ? "bg-[hsl(var(--accent))]" : "hover:bg-[hsl(var(--accent))]"
              )}
            >
              All {label}s
            </button>

            {filtered.map((item, idx) => {
              const checked = selected.includes(item.value);
              return (
                <button
                  key={`${item.value}-${idx}`}
                  type="button"
                  onClick={() => toggle(item.value)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-[hsl(var(--accent))]"
                >
                  <span className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    checked
                      ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                      : "border-[hsl(var(--border))]"
                  )}>
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="truncate">{item.label}</span>
                  {item.extra && (
                    <span className="ml-auto shrink-0 text-xs text-[hsl(var(--muted-foreground))]">{item.extra}</span>
                  )}
                </button>
              );
            })}

            {filtered.length === 0 && (
              <div className="py-4 text-center text-sm text-[hsl(var(--muted-foreground))]">No matches</div>
            )}
          </div>

          {!allSelected && (
            <div className="border-t border-[hsl(var(--border))] p-2">
              <button
                type="button"
                onClick={selectAll}
                className="w-full rounded-md px-2.5 py-1.5 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
              >
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ScopeFilter({ orgOnly = false }: ScopeFilterProps) {
  const {
    filterOptions,
    selectedEnterprises,
    selectedEntTeams,
    selectedOrgTeams,
    selectedOrgs,
    setSelectedEnterprises,
    setSelectedEntTeams,
    setSelectedOrgTeams,
    setSelectedOrgs,
    isMultiEnterprise,
  } = useScope();

  const { enterprises, enterpriseTeams: allEntTeams, orgTeams: allOrgTeams, orgs: allOrgs } = filterOptions;

  // When specific enterprises are selected, filter orgs and teams to only those enterprises.
  // Items without enterpriseSlug (legacy data) are included if only one enterprise is configured.
  const matchesEnterprise = (slug: string | undefined) =>
    slug ? selectedEnterprises.includes(slug) : enterprises.length <= 1;

  const enterpriseTeams = selectedEnterprises.length > 0
    ? allEntTeams.filter((t) => matchesEnterprise(t.enterpriseSlug))
    : allEntTeams;
  const orgTeams = selectedEnterprises.length > 0
    ? allOrgTeams.filter((t) => matchesEnterprise(t.enterpriseSlug))
    : allOrgTeams;
  const orgs = selectedEnterprises.length > 0
    ? allOrgs.filter((o) => matchesEnterprise(o.enterpriseSlug))
    : allOrgs;

  // Determine current mode based on selections
  const mode: ScopeMode =
    selectedEntTeams.length > 0 ? "enterprise" :
    (selectedOrgs.length > 0 || selectedOrgTeams.length > 0) ? "org" :
    "none";

  const enterpriseDisabled = mode === "org";
  const orgDisabled = mode === "enterprise";

  const entItems = enterpriseTeams.map((t) => ({
    value: isMultiEnterprise && t.enterpriseSlug ? `${t.enterpriseSlug}:${t.slug}` : t.slug,
    label: isMultiEnterprise && t.enterpriseSlug ? `${t.name} (${t.enterpriseSlug})` : t.name,
    extra: `${t.memberCount}`,
  }));
  const orgItems = orgs.map((o) => ({ value: o.slug, label: o.name }));
  const orgTeamItems = orgTeams.map((t) => ({
    value: isMultiEnterprise && t.enterpriseSlug ? `${t.enterpriseSlug}:${t.slug}` : t.slug,
    label: isMultiEnterprise && t.enterpriseSlug ? `${t.name} (${t.enterpriseSlug})` : t.name,
    extra: `${t.memberCount}`,
  }));
  const enterpriseItems = enterprises.map((e) => ({
    value: e.slug, label: e.displayName,
  }));

  const clearAll = () => {
    setSelectedEnterprises([]);
    setSelectedEntTeams([]);
    setSelectedOrgTeams([]);
    setSelectedOrgs([]);
  };

  const hasAnyFilter = selectedEnterprises.length > 0 || selectedEntTeams.length > 0 || selectedOrgTeams.length > 0 || selectedOrgs.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      {/* Enterprise selector — only shown when multiple enterprises configured */}
      {isMultiEnterprise && (
        <FilterDropdown
          label="Enterprise"
          icon={<Building2 className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />}
          items={enterpriseItems}
          selected={selectedEnterprises}
          onChange={setSelectedEnterprises}
          placeholder="All Enterprises"
        />
      )}

      {/* Separator between enterprise and team/org filters */}
      {isMultiEnterprise && (entItems.length > 0 || orgItems.length > 0) && (
        <span className="text-xs text-[hsl(var(--muted-foreground))] font-medium px-1">|</span>
      )}

      {/* Enterprise Teams — hidden in orgOnly mode */}
      {!orgOnly && entItems.length > 0 && (
        <FilterDropdown
          label="Enterprise Team"
          icon={<Shield className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />}
          items={entItems}
          selected={selectedEntTeams}
          onChange={(slugs) => {
            setSelectedEntTeams(slugs);
            if (slugs.length > 0) { setSelectedOrgTeams([]); setSelectedOrgs([]); }
          }}
          searchable
          placeholder="All Enterprise Teams"
          disabled={enterpriseDisabled}
          disabledReason="Clear org/team filters first"
        />
      )}

      {/* Separator — hidden in orgOnly mode */}
      {!orgOnly && entItems.length > 0 && (
        <span className="text-xs text-[hsl(var(--muted-foreground))] font-medium px-1">or</span>
      )}

      {/* Organizations */}
      {orgItems.length > 0 && (
        <FilterDropdown
          label="Organization"
          icon={<Building2 className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />}
          items={orgItems}
          selected={selectedOrgs}
          onChange={(slugs) => {
            setSelectedOrgs(slugs);
            if (slugs.length > 0) setSelectedEntTeams([]);
          }}
          placeholder="All Organizations"
          disabled={orgOnly ? false : orgDisabled}
          disabledReason={orgOnly ? undefined : "Clear enterprise team filters first"}
        />
      )}

      {/* Org Teams — hidden in orgOnly mode */}
      {!orgOnly && (
        <FilterDropdown
          label="Org Team"
          icon={<Users className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />}
          items={orgTeamItems}
          selected={selectedOrgTeams}
          onChange={(slugs) => {
            setSelectedOrgTeams(slugs);
            if (slugs.length > 0) setSelectedEntTeams([]);
          }}
          searchable
          placeholder="All Org Teams"
          disabled={orgDisabled}
          disabledReason="Clear enterprise team filters first"
        />
      )}

      {hasAnyFilter && (
        <button
          type="button"
          onClick={clearAll}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
        >
          <X className="h-3.5 w-3.5" />
          Clear all filters
        </button>
      )}

      {mode !== "none" && (
        <span className="text-xs text-[hsl(var(--muted-foreground))] italic">
          Filtering by {mode === "enterprise" ? "enterprise teams" : "organization scope"}
          {orgOnly && (selectedEntTeams.length > 0 || selectedOrgTeams.length > 0) && " (team filters ignored on this page)"}
        </span>
      )}
    </div>
  );
}

