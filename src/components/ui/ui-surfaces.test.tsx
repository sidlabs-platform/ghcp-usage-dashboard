// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";
import CommandPalette from "@/components/ui/CommandPalette";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { useExport } from "@/hooks/useExport";
import { getQueryClient } from "@/lib/query-client";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/hooks/useExport", () => ({
  useExport: vi.fn(),
}));

vi.mock("@/lib/query-client", () => ({
  getQueryClient: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    QueryClientProvider: ({
      children,
      client,
    }: {
      children: React.ReactNode;
      client: unknown;
    }) => (
      <div data-testid="query-provider" data-has-client={String(Boolean(client))}>
        {children}
      </div>
    ),
  };
});

const mockedUseExport = vi.mocked(useExport);
const mockedGetQueryClient = vi.mocked(getQueryClient);

beforeEach(() => {
  pushMock.mockReset();
  mockedUseExport.mockReturnValue({
    exporting: null,
    exportCSV: vi.fn().mockResolvedValue(undefined),
    exportPDF: vi.fn().mockResolvedValue(undefined),
  });
  mockedGetQueryClient.mockReturnValue({ id: "query-client" } as never);
  Object.defineProperty(window, "requestAnimationFrame", {
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("shared UI surfaces", () => {
  it("opens the command palette, filters results, and navigates on enter", async () => {
    render(<CommandPalette />);

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Search dashboard pages" });
    const input = screen.getByPlaceholderText(/Search pages/i);
    fireEvent.change(input, { target: { value: "AI Credits by User" } });
    expect(screen.getByText("AI Credits by User")).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/dashboard/ai-credits-users");
  });

  it("shows the empty state and closes the command palette on escape", async () => {
    render(<CommandPalette />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search dashboard pages" });
    fireEvent.change(screen.getByPlaceholderText(/Search pages/i), { target: { value: "zzz" } });

    expect(screen.getByText("No results found.")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("renders direct export buttons and dropdown exports", async () => {
    const exportCSV = vi.fn().mockResolvedValue(undefined);
    const exportPDF = vi.fn().mockResolvedValue(undefined);
    mockedUseExport.mockReturnValue({
      exporting: null,
      exportCSV,
      exportPDF,
    });

    const { rerender } = render(
      <ExportMenu
        csv={{
          fetchUrl: "/api/users",
          extraParams: new URLSearchParams(),
          columns: [],
          dataExtractor: () => [],
          filename: "users",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(exportCSV).toHaveBeenCalled();

    rerender(
      <ExportMenu
        csv={{
          fetchUrl: "/api/users",
          extraParams: new URLSearchParams(),
          columns: [],
          dataExtractor: () => [],
          filename: "users",
        }}
        pdf={{
          sectionRefs: [],
          title: "Users",
          filename: "users-report",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export as PDF" }));
    expect(exportPDF).toHaveBeenCalled();
  });

  it("renders the query provider wrapper with the shared client", () => {
    render(
      <QueryProvider>
        <div>child content</div>
      </QueryProvider>,
    );

    expect(screen.getByTestId("query-provider")).toHaveAttribute("data-has-client", "true");
    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(mockedGetQueryClient).toHaveBeenCalled();
  });

  it("renders button and badge variants", () => {
    render(
      <div>
        <Button variant="outline" size="sm">Run export</Button>
        <Badge variant="success">Ready</Badge>
      </div>,
    );

    expect(screen.getByRole("button", { name: "Run export" })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(buttonVariants({ variant: "outline", size: "sm" })).toContain("border");
    expect(badgeVariants({ variant: "success" })).toContain("emerald");
  });
});
