import { describe, it, expect } from "vitest";
import {
  parsePaginationParams,
  buildLimitOffset,
  buildOrderBy,
  paginatedResponse,
  paginateArray,
} from "./pagination";

describe("parsePaginationParams", () => {
  it("returns defaults when no params provided", () => {
    const params = parsePaginationParams(new URLSearchParams());
    expect(params).toEqual({
      page: 1,
      pageSize: 50,
      sortField: "id",
      sortDir: "desc",
      search: undefined,
    });
  });

  it("parses valid page and pageSize", () => {
    const sp = new URLSearchParams({ page: "3", pageSize: "25" });
    const params = parsePaginationParams(sp);
    expect(params.page).toBe(3);
    expect(params.pageSize).toBe(25);
  });

  it("clamps page to minimum of 1", () => {
    const sp = new URLSearchParams({ page: "0" });
    expect(parsePaginationParams(sp).page).toBe(1);
    const sp2 = new URLSearchParams({ page: "-5" });
    expect(parsePaginationParams(sp2).page).toBe(1);
  });

  it("clamps pageSize to max 200", () => {
    const sp = new URLSearchParams({ pageSize: "500" });
    expect(parsePaginationParams(sp).pageSize).toBe(200);
  });

  it("clamps pageSize to min 1", () => {
    const sp = new URLSearchParams({ pageSize: "0" });
    expect(parsePaginationParams(sp).pageSize).toBe(1);
  });

  it("parses sort field and direction", () => {
    const sp = new URLSearchParams({ sort: "name", sortDir: "asc" });
    const params = parsePaginationParams(sp);
    expect(params.sortField).toBe("name");
    expect(params.sortDir).toBe("asc");
  });

  it("uses custom default sort and dir", () => {
    const params = parsePaginationParams(new URLSearchParams(), "created_at", "asc");
    expect(params.sortField).toBe("created_at");
    expect(params.sortDir).toBe("asc");
  });

  it("defaults invalid sortDir to the default direction", () => {
    const sp = new URLSearchParams({ sortDir: "invalid" });
    const params = parsePaginationParams(sp, "id", "desc");
    expect(params.sortDir).toBe("desc");
  });

  it("parses search parameter", () => {
    const sp = new URLSearchParams({ search: "alice" });
    expect(parsePaginationParams(sp).search).toBe("alice");
  });
});

describe("buildLimitOffset", () => {
  it("returns correct LIMIT/OFFSET for page 1", () => {
    const result = buildLimitOffset({ page: 1, pageSize: 50, sortField: "id", sortDir: "desc" });
    expect(result.clause).toBe("LIMIT ? OFFSET ?");
    expect(result.values).toEqual([50, 0]);
  });

  it("calculates offset for page 3 with pageSize 20", () => {
    const result = buildLimitOffset({ page: 3, pageSize: 20, sortField: "id", sortDir: "desc" });
    expect(result.values).toEqual([20, 40]);
  });
});

describe("buildOrderBy", () => {
  const allowed = ["name", "count", "created_at"];

  it("uses the sort field when it is in the allowed list", () => {
    const result = buildOrderBy({ page: 1, pageSize: 50, sortField: "name", sortDir: "asc" }, allowed);
    expect(result).toBe("ORDER BY name ASC");
  });

  it("falls back to defaultColumn when sort field is not allowed", () => {
    const result = buildOrderBy(
      { page: 1, pageSize: 50, sortField: "hacked", sortDir: "desc" },
      allowed,
      "created_at",
    );
    expect(result).toBe("ORDER BY created_at DESC");
  });

  it("falls back to first allowed column when no defaultColumn provided", () => {
    const result = buildOrderBy(
      { page: 1, pageSize: 50, sortField: "unknown", sortDir: "asc" },
      allowed,
    );
    expect(result).toBe("ORDER BY name ASC");
  });
});

describe("paginatedResponse", () => {
  it("wraps data with pagination metadata", () => {
    const result = paginatedResponse(["a", "b"], 100, { page: 2, pageSize: 50, sortField: "id", sortDir: "desc" });
    expect(result.data).toEqual(["a", "b"]);
    expect(result.pagination).toEqual({ page: 2, pageSize: 50, totalItems: 100, totalPages: 2 });
  });

  it("calculates totalPages with ceiling division", () => {
    const result = paginatedResponse([], 101, { page: 1, pageSize: 50, sortField: "id", sortDir: "desc" });
    expect(result.pagination.totalPages).toBe(3);
  });
});

describe("paginateArray", () => {
  const items = Array.from({ length: 95 }, (_, i) => i);

  it("returns the correct slice for page 1", () => {
    const result = paginateArray(items, { page: 1, pageSize: 10, sortField: "id", sortDir: "desc" });
    expect(result.data).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.pagination.totalItems).toBe(95);
    expect(result.pagination.totalPages).toBe(10);
  });

  it("returns the correct slice for a middle page", () => {
    const result = paginateArray(items, { page: 3, pageSize: 10, sortField: "id", sortDir: "desc" });
    expect(result.data).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });

  it("returns partial last page", () => {
    const result = paginateArray(items, { page: 10, pageSize: 10, sortField: "id", sortDir: "desc" });
    expect(result.data).toEqual([90, 91, 92, 93, 94]);
  });

  it("returns empty data for out-of-bounds page", () => {
    const result = paginateArray(items, { page: 20, pageSize: 10, sortField: "id", sortDir: "desc" });
    expect(result.data).toEqual([]);
  });
});
