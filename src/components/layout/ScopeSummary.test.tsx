// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScopeSummary } from "@/components/layout/ScopeSummary";

const mockState = vi.hoisted(() => ({
  dateRange: {
    days: 28,
    mode: "preset" as "preset" | "custom" | "month",
    startDate: "",
    endDate: "",
    period: null as string | null,
  },
  scope: {
    hasFilter: false,
    selectedEnterprises: [] as string[],
    selectedEntTeams: [] as string[],
    selectedOrgTeams: [] as string[],
    selectedOrgs: [] as string[],
    setSelectedEnterprises: vi.fn(),
    setSelectedEntTeams: vi.fn(),
    setSelectedOrgTeams: vi.fn(),
    setSelectedOrgs: vi.fn(),
    clearAll: vi.fn(),
  },
}));

vi.mock("@/contexts/DateRangeContext", () => ({
  useDateRange: () => mockState.dateRange,
}));

vi.mock("@/contexts/ScopeContext", () => ({
  useScope: () => mockState.scope,
}));

function setClipboard(clipboard: Pick<Clipboard, "writeText"> | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
}

beforeEach(() => {
  window.history.pushState({}, "", "/dashboard?days=28&orgs=octo-org");
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ScopeSummary", () => {
  it("announces a clipboard failure instead of showing success", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });

    render(<ScopeSummary />);

    fireEvent.click(screen.getByRole("button", { name: "Copy link to this view" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(window.location.href);
    });
    expect(await screen.findByText("Copy failed")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copy failed. Use the address bar to copy this link.",
    );
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("handles missing clipboard support without throwing", async () => {
    setClipboard(undefined);

    render(<ScopeSummary />);

    fireEvent.click(screen.getByRole("button", { name: "Copy link to this view" }));

    expect(await screen.findByText("Copy failed")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copy failed. Use the address bar to copy this link.",
    );
  });

  it("cleans up the success reset timer on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const { unmount } = render(<ScopeSummary />);

    fireEvent.click(screen.getByRole("button", { name: "Copy link to this view" }));

    expect(await screen.findByText("Copied")).toBeVisible();
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
