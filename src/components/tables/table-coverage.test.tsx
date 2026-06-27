// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaginatedTable, type ColumnDef } from "@/components/tables/PaginatedTable";

interface Row {
  id: string;
  name: string;
  score: number;
}

const columns: ColumnDef<Row>[] = [
  { key: "name", label: "Name", render: (row) => row.name },
  { key: "score", label: "Score", align: "right", render: (row) => row.score.toString() },
];

function renderTable(fetchImpl: typeof fetch, onTotalChange = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  vi.stubGlobal("fetch", fetchImpl);

  render(
    <QueryClientProvider client={queryClient}>
      <PaginatedTable<Row>
        fetchUrl="/api/users"
        columns={columns}
        defaultSort="name"
        defaultSortDir="desc"
        rowKey={(row) => row.id}
        dataExtractor={(json) => json.users as Row[]}
        queryKey="users"
        searchable
        searchPlaceholder="Search users"
        pageSizeOptions={[1, 2]}
        onTotalChange={onTotalChange}
      />
    </QueryClientProvider>,
  );

  return { queryClient, onTotalChange };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PaginatedTable", () => {
  it("loads rows, sorts, debounces search, updates page size, and reports totals", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return {
        ok: true,
        json: async () => ({
          users: [
            { id: "1", name: "Alice", score: 10 },
            { id: "2", name: "Bob", score: 8 },
          ],
          pagination: {
            page: 1,
            pageSize: 2,
            totalItems: 2,
            totalPages: 2,
          },
        }),
      } as Response;
    });

    const { onTotalChange } = renderTable(fetchMock);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(requests[0]).toContain("page=1");
    expect(requests[0]).toContain("pageSize=2");
    expect(requests[0]).toContain("sort=name");
    expect(requests[0]).toContain("sortDir=desc");
    expect(onTotalChange).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => {
      expect(requests.at(-1)).toContain("sortDir=asc");
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search users"), {
        target: { value: "Ali" },
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitFor(() => {
      expect(requests.at(-1)).toContain("search=Ali");
    });

    fireEvent.change(screen.getByDisplayValue("2"), {
      target: { value: "1" },
    });
    await waitFor(() => {
      expect(requests.at(-1)).toContain("pageSize=1");
    });
  });

  it("renders an error state when the request fails", async () => {
    renderTable(vi.fn(async () => ({ ok: false, status: 500 } as Response)));

    expect(await screen.findByText("HTTP 500")).toBeInTheDocument();
  });

  it("renders an empty state when no rows are returned", async () => {
    renderTable(
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          users: [],
          pagination: {
            page: 1,
            pageSize: 2,
            totalItems: 0,
            totalPages: 0,
          },
        }),
      }) as Response),
    );

    expect(await screen.findByText("No data available.")).toBeInTheDocument();
  });
});
