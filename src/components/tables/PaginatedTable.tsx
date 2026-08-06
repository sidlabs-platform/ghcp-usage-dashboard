"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { SortableHeader } from "./SortableHeader";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface ColumnDef<T> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right";
  render: (row: T) => React.ReactNode;
}

interface PaginationInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

interface PaginatedTableProps<T> {
  /** Base URL for the API endpoint (e.g., "/api/users") */
  fetchUrl: string;
  /** Extra query params (days, teams, orgs, etc.) */
  extraParams?: URLSearchParams;
  /** Column definitions */
  columns: ColumnDef<T>[];
  /** Default sort field */
  defaultSort: string;
  /** Default sort direction */
  defaultSortDir?: "asc" | "desc";
  /** Key function to generate unique row key */
  rowKey: (row: T) => string;
  /** Data extractor from response JSON — e.g., (json) => json.users */
  dataExtractor: (json: Record<string, unknown>) => T[];
  /** Query key prefix for React Query */
  queryKey: string;
  /** Show search box? */
  searchable?: boolean;
  /** Search placeholder */
  searchPlaceholder?: string;
  /** Page size options */
  pageSizeOptions?: number[];
  /** Called when total items count changes */
  onTotalChange?: (total: number) => void;
}

export function PaginatedTable<T>({
  fetchUrl,
  extraParams,
  columns,
  defaultSort,
  defaultSortDir = "desc",
  rowKey,
  dataExtractor,
  queryKey,
  searchable = false,
  searchPlaceholder = "Search...",
  pageSizeOptions = [25, 50, 100],
  onTotalChange,
}: PaginatedTableProps<T>) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizeOptions[1] || 50);
  const [sortField, setSortField] = useState(defaultSort);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSortDir);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const extraParamsKey = extraParams?.toString() ?? "";
  const previousExtraParamsKeyRef = useRef(extraParamsKey);

  // Debounce search
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  }, []);

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams(extraParamsKey);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    params.set("sort", sortField);
    params.set("sortDir", sortDir);
    if (debouncedSearch) params.set("search", debouncedSearch);
    return `${fetchUrl}?${params.toString()}`;
  }, [fetchUrl, extraParamsKey, page, pageSize, sortField, sortDir, debouncedSearch]);

  useEffect(() => {
    if (previousExtraParamsKeyRef.current === extraParamsKey) return;
    previousExtraParamsKeyRef.current = extraParamsKey;
    setPage(1);
  }, [extraParamsKey]);

  const { data, isLoading, error } = useQuery({
    queryKey: [queryKey, fetchUrl, page, pageSize, sortField, sortDir, debouncedSearch, extraParamsKey],
    queryFn: async () => {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows: T[] = data ? dataExtractor(data) : [];
  const pagination: PaginationInfo | undefined = data?.pagination;

  // Notify parent of total count (in useEffect to avoid setState-during-render)
  const prevTotalRef = useRef<number>(undefined);
  useEffect(() => {
    if (pagination && pagination.totalItems !== prevTotalRef.current && onTotalChange) {
      prevTotalRef.current = pagination.totalItems;
      onTotalChange(pagination.totalItems);
    }
  }, [pagination?.totalItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSort = useCallback((field: string) => {
    if (field === sortField) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
    setPage(1);
  }, [sortField]);

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  }, []);

  return (
    <div>
      {/* Search bar */}
      {searchable && (
        <div className="mb-4">
          <label htmlFor={`search-${queryKey}`} className="sr-only">
            {searchPlaceholder}
          </label>
          <input
            id={`search-${queryKey}`}
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="h-9 w-64 rounded-md border bg-transparent pl-3 pr-3 text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
        </div>
      )}

      {/* Loading state */}
      {isLoading && rows.length === 0 && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-[hsl(var(--muted))]/50" />
          ))}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex h-32 items-center justify-center text-sm text-red-500">
          {error instanceof Error ? error.message : "Failed to load data"}
        </div>
      )}

      {/* Table */}
      {!error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                {columns.map((col, idx) => (
                  col.sortable !== false ? (
                    <SortableHeader
                      key={col.key}
                      label={col.label}
                      field={col.key}
                      sortField={sortField}
                      sortAsc={sortDir === "asc"}
                      onSort={handleSort}
                      align={col.align}
                      last={idx === columns.length - 1}
                    />
                  ) : (
                    <th key={col.key} className={`pb-3 font-medium ${col.align === "right" ? "text-right" : ""}`}>
                      {col.label}
                    </th>
                  )
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-b last:border-0">
                  {columns.map((col) => (
                    <td key={col.key} className={`py-3 pr-4 ${col.align === "right" ? "text-right" : ""}`}>
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && rows.length === 0 && (
        <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          No data available.
        </div>
      )}

      {/* Pagination controls */}
      {pagination && pagination.totalPages > 0 && (
        <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm text-[hsl(var(--muted-foreground))]">
          <div className="flex items-center gap-2">
            <label htmlFor={`pagesize-${queryKey}`}>Rows per page:</label>
            <select
              id={`pagesize-${queryKey}`}
              value={pageSize}
              onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              className="rounded border bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
            <span className="ml-2">
              {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, pagination.totalItems)} of {pagination.totalItems.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
              className="rounded p-1 hover:bg-[hsl(var(--muted))] disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-2" aria-live="polite">
              Page {page} of {pagination.totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              disabled={page >= pagination.totalPages}
              aria-label="Next page"
              className="rounded p-1 hover:bg-[hsl(var(--muted))] disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
