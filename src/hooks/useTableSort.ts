import { useState, useMemo } from "react";

type SortDirection = "asc" | "desc";

interface UseTableSortResult<T, K extends keyof T> {
  sortedData: T[];
  sortField: K;
  sortAsc: boolean;
  handleSort: (field: K) => void;
  sortIndicator: (field: K) => string;
}

/**
 * Generic hook for client-side table sorting.
 * Handles string, number, boolean, null/undefined comparison.
 * Null/undefined values are pushed to the end regardless of direction.
 */
export function useTableSort<T, K extends keyof T>(
  data: T[],
  defaultField: K,
  defaultDirection: SortDirection = "desc"
): UseTableSortResult<T, K> {
  const [sortField, setSortField] = useState<K>(defaultField);
  const [sortAsc, setSortAsc] = useState(defaultDirection === "asc");

  const handleSort = (field: K) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortIndicator = (field: K): string =>
    sortField === field ? (sortAsc ? " ↑" : " ↓") : "";

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];

      // Push nulls/undefined to the end
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let cmp: number;
      if (typeof aVal === "string" && typeof bVal === "string") {
        cmp = aVal.localeCompare(bVal);
      } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
        cmp = (aVal === bVal) ? 0 : aVal ? -1 : 1;
      } else {
        cmp = (aVal as number) - (bVal as number);
      }

      return sortAsc ? cmp : -cmp;
    });
  }, [data, sortField, sortAsc]);

  return { sortedData, sortField, sortAsc, handleSort, sortIndicator };
}
