"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export interface ScopeFilterOptions {
  enterpriseTeams: { slug: string; name: string; memberCount: number }[];
  orgTeams: { slug: string; name: string; orgSlug: string; memberCount: number }[];
  orgs: { slug: string; name: string }[];
}

interface ScopeContextType {
  filterOptions: ScopeFilterOptions;
  selectedEntTeams: string[];
  selectedOrgTeams: string[];
  selectedOrgs: string[];
  setSelectedEntTeams: (slugs: string[]) => void;
  setSelectedOrgTeams: (slugs: string[]) => void;
  setSelectedOrgs: (slugs: string[]) => void;
  clearAll: () => void;
  hasFilter: boolean;
  /** Build URLSearchParams with teams= and orgs= for API calls */
  buildScopeParams: () => URLSearchParams;
}

const ScopeContext = createContext<ScopeContextType>({
  filterOptions: { enterpriseTeams: [], orgTeams: [], orgs: [] },
  selectedEntTeams: [],
  selectedOrgTeams: [],
  selectedOrgs: [],
  setSelectedEntTeams: () => {},
  setSelectedOrgTeams: () => {},
  setSelectedOrgs: () => {},
  clearAll: () => {},
  hasFilter: false,
  buildScopeParams: () => new URLSearchParams(),
});

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [filterOptions, setFilterOptions] = useState<ScopeFilterOptions>({
    enterpriseTeams: [],
    orgTeams: [],
    orgs: [],
  });
  const [selectedEntTeams, setSelectedEntTeams] = useState<string[]>([]);
  const [selectedOrgTeams, setSelectedOrgTeams] = useState<string[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);

  // Fetch filter options once on mount
  useEffect(() => {
    fetch("/api/filters")
      .then((res) => res.json())
      .then((json) => {
        if (!json.error) setFilterOptions(json);
      })
      .catch(() => {});
  }, []);

  const clearAll = useCallback(() => {
    setSelectedEntTeams([]);
    setSelectedOrgTeams([]);
    setSelectedOrgs([]);
  }, []);

  const hasFilter = selectedEntTeams.length > 0 || selectedOrgTeams.length > 0 || selectedOrgs.length > 0;

  const buildScopeParams = useCallback(() => {
    const params = new URLSearchParams();
    const allTeams = [...selectedEntTeams, ...selectedOrgTeams];
    if (allTeams.length > 0) params.set("teams", allTeams.join(","));
    if (selectedOrgs.length > 0) params.set("orgs", selectedOrgs.join(","));
    return params;
  }, [selectedEntTeams, selectedOrgTeams, selectedOrgs]);

  return (
    <ScopeContext.Provider
      value={{
        filterOptions,
        selectedEntTeams,
        selectedOrgTeams,
        selectedOrgs,
        setSelectedEntTeams,
        setSelectedOrgTeams,
        setSelectedOrgs,
        clearAll,
        hasFilter,
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
