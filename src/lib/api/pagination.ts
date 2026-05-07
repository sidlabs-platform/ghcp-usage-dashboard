// Server-side pagination utilities for API routes

export interface PaginationParams {
  page: number;
  pageSize: number;
  sortField: string;
  sortDir: "asc" | "desc";
  search?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Parse pagination parameters from URL search params.
 * Returns validated, clamped values.
 */
export function parsePaginationParams(
  searchParams: URLSearchParams,
  defaultSort: string = "id",
  defaultDir: "asc" | "desc" = "desc",
): PaginationParams {
  const rawPage = parseInt(searchParams.get("page") || "1", 10);
  const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);
  const rawPageSize = parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10);
  const pageSize = Math.min(Math.max(1, Number.isNaN(rawPageSize) ? DEFAULT_PAGE_SIZE : rawPageSize), MAX_PAGE_SIZE);
  const sortField = searchParams.get("sort") || defaultSort;
  const sortDir = (searchParams.get("sortDir") === "asc" ? "asc" : searchParams.get("sortDir") === "desc" ? "desc" : defaultDir) as "asc" | "desc";
  const search = searchParams.get("search") || undefined;

  return { page, pageSize, sortField, sortDir, search };
}

/**
 * Build SQL LIMIT/OFFSET clause from pagination params.
 */
export function buildLimitOffset(params: PaginationParams): { clause: string; values: [number, number] } {
  const offset = (params.page - 1) * params.pageSize;
  return {
    clause: `LIMIT ? OFFSET ?`,
    values: [params.pageSize, offset],
  };
}

/**
 * Build SQL ORDER BY clause from pagination params.
 * Only allows sorting by pre-approved column names to prevent SQL injection.
 */
export function buildOrderBy(
  params: PaginationParams,
  allowedColumns: string[],
  defaultColumn?: string,
): string {
  const column = allowedColumns.includes(params.sortField)
    ? params.sortField
    : (defaultColumn || allowedColumns[0]);
  return `ORDER BY ${column} ${params.sortDir.toUpperCase()}`;
}

/**
 * Wrap a data array + total count into a PaginatedResponse.
 */
export function paginatedResponse<T>(
  data: T[],
  totalItems: number,
  params: PaginationParams,
): PaginatedResponse<T> {
  return {
    data,
    pagination: {
      page: params.page,
      pageSize: params.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / params.pageSize),
    },
  };
}

/**
 * Apply in-memory pagination to an already-fetched array.
 * Useful when data comes from non-SQL sources or complex JS aggregation.
 */
export function paginateArray<T>(
  items: T[],
  params: PaginationParams,
): PaginatedResponse<T> {
  const totalItems = items.length;
  const start = (params.page - 1) * params.pageSize;
  const data = items.slice(start, start + params.pageSize);
  return paginatedResponse(data, totalItems, params);
}
