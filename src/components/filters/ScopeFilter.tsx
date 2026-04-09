"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Building2, Users, ChevronDown, Search, X, Check, Shield } from "lucide-react";

export interface ScopeFilterProps {
  enterpriseTeams: { slug: string; name: string; memberCount: number }[];
  orgTeams: { slug: string; name: string; orgSlug: string; memberCount: number }[];
  orgs: { slug: string; name: string }[];
  selectedEnterpriseTeams: string[];
  selectedOrgTeams: string[];
  selectedOrgs: string[];
  onEnterpriseTeamsChange: (slugs: string[]) => void;
  onOrgTeamsChange: (slugs: string[]) => void;
  onOrgsChange: (slugs: string[]) => void;
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

export function ScopeFilter({
  enterpriseTeams,
  orgTeams,
  orgs,
  selectedEnterpriseTeams,
  selectedOrgTeams,
  selectedOrgs,
  onEnterpriseTeamsChange,
  onOrgTeamsChange,
  onOrgsChange,
}: ScopeFilterProps) {
  // Determine current mode based on selections
  const mode: ScopeMode =
    selectedEnterpriseTeams.length > 0 ? "enterprise" :
    (selectedOrgs.length > 0 || selectedOrgTeams.length > 0) ? "org" :
    "none";

  const enterpriseDisabled = mode === "org";
  const orgDisabled = mode === "enterprise";

  const entItems = enterpriseTeams.map((t) => ({
    value: t.slug, label: t.name, extra: `${t.memberCount}`,
  }));
  const orgItems = orgs.map((o) => ({ value: o.slug, label: o.name }));
  const orgTeamItems = orgTeams.map((t) => ({
    value: t.slug, label: t.name, extra: `${t.memberCount}`,
  }));

  const clearAll = () => {
    onEnterpriseTeamsChange([]);
    onOrgTeamsChange([]);
    onOrgsChange([]);
  };

  const hasAnyFilter = selectedEnterpriseTeams.length > 0 || selectedOrgTeams.length > 0 || selectedOrgs.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      {/* Enterprise Teams */}
      {entItems.length > 0 && (
        <FilterDropdown
          label="Enterprise Team"
          icon={<Shield className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />}
          items={entItems}
          selected={selectedEnterpriseTeams}
          onChange={(slugs) => {
            onEnterpriseTeamsChange(slugs);
            if (slugs.length > 0) { onOrgTeamsChange([]); onOrgsChange([]); }
          }}
          searchable
          placeholder="All Enterprise Teams"
          disabled={enterpriseDisabled}
          disabledReason="Clear org/team filters first"
        />
      )}

      {/* Separator */}
      {entItems.length > 0 && (
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
            onOrgsChange(slugs);
            if (slugs.length > 0) onEnterpriseTeamsChange([]);
          }}
          placeholder="All Organizations"
          disabled={orgDisabled}
          disabledReason="Clear enterprise team filters first"
        />
      )}

      {/* Org Teams */}
      <FilterDropdown
        label="Org Team"
        icon={<Users className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />}
        items={orgTeamItems}
        selected={selectedOrgTeams}
        onChange={(slugs) => {
          onOrgTeamsChange(slugs);
          if (slugs.length > 0) onEnterpriseTeamsChange([]);
        }}
        searchable
        placeholder="All Org Teams"
        disabled={orgDisabled}
        disabledReason="Clear enterprise team filters first"
      />

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
        </span>
      )}
    </div>
  );
}

