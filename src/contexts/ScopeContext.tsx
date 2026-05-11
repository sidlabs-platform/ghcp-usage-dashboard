"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

export interface EnterpriseInfo {
  slug: string;
  displayName: string;
}

export interface ScopeFilterOptions {
  enterprises: EnterpriseInfo[];
  enterpriseTeams: { slug: string; name: string; enterpriseSlug?: string; memberCount: number }[];
  orgTeams: { slug: string; name: string; orgSlug: string; enterpriseSlug?: string; memberCount: number }[];
  orgs: { slug: string; name: string; enterpriseSlug?: string }[];
}

interface ScopeContextType {
  filterOptions: ScopeFilterOptions;
  selectedEnterprises: string[];
  selectedEntTeams: string[];
  selectedOrgTeams: string[];
  selectedOrgs: string[];
  setSelectedEnterprises: (slugs: string[]) => void;
  setSelectedEntTeams: (slugs: string[]) => void;
  setSelectedOrgTeams: (slugs: string[]) => void;
  setSelectedOrgs: (slugs: string[]) => void;
  clearAll: () => void;
  hasFilter: boolean;
  isMultiEnterprise: boolean;
  /** Build URLSearchParams with enterprises=, teams=, and orgs= for API calls */
  buildScopeParams: () => URLSearchParams;
}

const ScopeContext = createContext<ScopeContextType>({
  filterOptions: { enterprises: [], enterpriseTeams: [], orgTeams: [], orgs: [] },
  selectedEnterprises: [],
  selectedEntTeams: [],
  selectedOrgTeams: [],
  selectedOrgs: [],
  setSelectedEnterprises: () => {},
  setSelectedEntTeams: () => {},
  setSelectedOrgTeams: () => {},
  setSelectedOrgs: () => {},
  clearAll: () => {},
  hasFilter: false,
  isMultiEnterprise: false,
  buildScopeParams: () => new URLSearchParams(),
});

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [filterOptions, setFilterOptions] = useState<ScopeFilterOptions>({
    enterprises: [],
    enterpriseTeams: [],
    orgTeams: [],
    orgs: [],
  });
  const [selectedEnterprises, setSelectedEnterprises] = useState<string[]>([]);
  const [selectedEntTeams, setSelectedEntTeams] = useState<string[]>([]);
  const [selectedOrgTeams, setSelectedOrgTeams] = useState<string[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);

  const { data: filterData } = useQuery({
    queryKey: ["filters"],
    queryFn: async () => {
      const res = await fetch("/api/filters");
      if (!res.ok) throw new Error("Failed to fetch filters");
      return res.json();
    },
    staleTime: 30 * 60 * 1000, // 30 minutes
  });

  useEffect(() => {
    if (filterData && !filterData.error) {
      setFilterOptions({
        enterprises: filterData.enterprises || [],
        enterpriseTeams: filterData.enterpriseTeams || [],
        orgTeams: filterData.orgTeams || [],
        orgs: filterData.orgs || [],
      });
    }
  }, [filterData]);

  // Prune org/team selections that don't belong to the currently selected enterprises.
  // Uses functional state updates to avoid stale closure issues.
  // Matches ScopeFilter's matchesEnterprise logic: items without enterpriseSlug are
  // kept when only one enterprise is configured (legacy data compatibility).
  useEffect(() => {
    if (selectedEnterprises.length === 0) return;

    const opts = filterOptions;
    const singleEnterprise = opts.enterprises.length <= 1;
    const matchesEnt = (entSlug: string | undefined) =>
      entSlug ? selectedEnterprises.includes(entSlug) : singleEnterprise;

    setSelectedOrgTeams((prev) => {
      const pruned = prev.filter((slug) =>
        opts.orgTeams.some((t) => {
          const qualifiedSlug = t.enterpriseSlug ? `${t.enterpriseSlug}:${t.slug}` : t.slug;
          return (qualifiedSlug === slug || t.slug === slug) && matchesEnt(t.enterpriseSlug);
        }),
      );
      return pruned.length === prev.length ? prev : pruned;
    });

    setSelectedEntTeams((prev) => {
      const pruned = prev.filter((slug) =>
        opts.enterpriseTeams.some((t) => {
          const qualifiedSlug = t.enterpriseSlug ? `${t.enterpriseSlug}:${t.slug}` : t.slug;
          return (qualifiedSlug === slug || t.slug === slug) && matchesEnt(t.enterpriseSlug);
        }),
      );
      return pruned.length === prev.length ? prev : pruned;
    });

    setSelectedOrgs((prev) => {
      const pruned = prev.filter((slug) =>
        opts.orgs.some((o) => o.slug === slug && matchesEnt(o.enterpriseSlug)),
      );
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [selectedEnterprises, filterOptions]);

  const clearAll = useCallback(() => {
    setSelectedEnterprises([]);
    setSelectedEntTeams([]);
    setSelectedOrgTeams([]);
    setSelectedOrgs([]);
  }, []);

  const isMultiEnterprise = filterOptions.enterprises.length > 1;

  const hasFilter =
    selectedEnterprises.length > 0 ||
    selectedEntTeams.length > 0 ||
    selectedOrgTeams.length > 0 ||
    selectedOrgs.length > 0;

  const buildScopeParams = useCallback(() => {
    const params = new URLSearchParams();
    if (selectedEnterprises.length > 0) params.set("enterprises", selectedEnterprises.join(","));
    const allTeams = [...selectedEntTeams, ...selectedOrgTeams];
    if (allTeams.length > 0) params.set("teams", allTeams.join(","));
    if (selectedOrgs.length > 0) params.set("orgs", selectedOrgs.join(","));
    return params;
  }, [selectedEnterprises, selectedEntTeams, selectedOrgTeams, selectedOrgs]);

  return (
    <ScopeContext.Provider
      value={{
        filterOptions,
        selectedEnterprises,
        selectedEntTeams,
        selectedOrgTeams,
        selectedOrgs,
        setSelectedEnterprises,
        setSelectedEntTeams,
        setSelectedOrgTeams,
        setSelectedOrgs,
        clearAll,
        hasFilter,
        isMultiEnterprise,
        buildScopeParams,
      }}
    >
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  return useContext(ScopeContext);
}
