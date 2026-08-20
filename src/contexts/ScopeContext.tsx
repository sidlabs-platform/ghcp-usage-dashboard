"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  Suspense,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  parseScopeFromURL,
  serializeScopeToURL,
  applyParamsToURL,
} from "@/lib/url/params";

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
  setSelectedEnterprises: Dispatch<SetStateAction<string[]>>;
  setSelectedEntTeams: Dispatch<SetStateAction<string[]>>;
  setSelectedOrgTeams: Dispatch<SetStateAction<string[]>>;
  setSelectedOrgs: Dispatch<SetStateAction<string[]>>;
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

/**
 * True when two string arrays hold the same values in the same order.
 */
function sameMembers(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Applies a URL-parsed value to array state without churning its identity.
 *
 * `parseScopeFromURL` allocates a fresh array on every call, so calling the
 * setter unconditionally makes state "change" on every `searchParams` tick even
 * when the selection is identical. That re-renders every `ScopeContext`
 * consumer and re-fires their queries; if `searchParams` also has a new
 * identity per render, the URL→state effect re-runs forever. Returning `prev`
 * lets React bail out of the re-render entirely.
 */
function applyIfChanged(setter: Dispatch<SetStateAction<string[]>>, next: string[]): void {
  setter((prev) => (sameMembers(prev, next) ? prev : next));
}

/**
 * Inner component that bridges scope filter state to the URL.
 *
 * Wrapped in `<Suspense>` because it calls `useSearchParams()`.
 *
 * Loop avoidance: same `lastWrittenRef` pattern as `DateRangeURLSync` — the
 * URL→state effect skips when `searchParams` matches what we last wrote.
 */
function ScopeURLSync({
  selectedEnterprises,
  selectedEntTeams,
  selectedOrgTeams,
  selectedOrgs,
}: {
  selectedEnterprises: string[];
  selectedEntTeams: string[];
  selectedOrgTeams: string[];
  selectedOrgs: string[];
}) {
  const {
    setSelectedEnterprises,
    setSelectedEntTeams,
    setSelectedOrgTeams,
    setSelectedOrgs,
  } = useScope();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const initialized = useRef(false);
  const lastWritten = useRef<string>("");
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  // Effect 1: URL → state (on mount and on external URL changes)
  useEffect(() => {
    const currentStr = searchParams.toString();
    if (initialized.current && currentStr === lastWritten.current) return;

    const parsed = parseScopeFromURL(searchParams);
    applyIfChanged(setSelectedEnterprises, parsed.enterprises);
    applyIfChanged(setSelectedEntTeams, parsed.entTeams);
    applyIfChanged(setSelectedOrgTeams, parsed.orgTeams);
    applyIfChanged(setSelectedOrgs, parsed.orgs);
    initialized.current = true;
  }, [searchParams, setSelectedEnterprises, setSelectedEntTeams, setSelectedOrgTeams, setSelectedOrgs]);

  // Effect 2: state → URL
  useEffect(() => {
    if (!initialized.current) return;

    const updates = serializeScopeToURL(
      selectedEnterprises,
      selectedEntTeams,
      selectedOrgTeams,
      selectedOrgs,
    );
    const next = applyParamsToURL(searchParamsRef.current, updates);
    const nextStr = next.toString();

    if (nextStr === searchParamsRef.current.toString()) return;

    lastWritten.current = nextStr;
    const newUrl = nextStr ? `${pathname}?${nextStr}` : pathname;
    router.replace(newUrl, { scroll: false });
  }, [
    selectedEnterprises,
    selectedEntTeams,
    selectedOrgTeams,
    selectedOrgs,
    pathname,
    router,
  ]);

  return null;
}

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
      {/* Suspense required by Next.js App Router for useSearchParams. */}
      <Suspense fallback={null}>
        <ScopeURLSync
          selectedEnterprises={selectedEnterprises}
          selectedEntTeams={selectedEntTeams}
          selectedOrgTeams={selectedOrgTeams}
          selectedOrgs={selectedOrgs}
        />
      </Suspense>
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  return useContext(ScopeContext);
}
