// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { SidebarProvider, useSidebar } from "@/components/layout/SidebarContext";

const mockState = vi.hoisted(() => ({
  pathname: "/dashboard",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockState.pathname,
}));

function mockJsonResponse(payload: unknown) {
  return Promise.resolve({
    json: async () => payload,
  } as Response);
}

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQueryList = {
    matches,
    media: "(max-width: 767px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === "change") listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === "change") listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(() => false),
  };

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockReturnValue(mediaQueryList),
  });

  return mediaQueryList;
}

function SidebarHarness() {
  const { open } = useSidebar();
  return (
    <>
      <button type="button" onClick={open}>
        Open test navigation
      </button>
      <Sidebar />
    </>
  );
}

function renderSidebar() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/config") {
      return mockJsonResponse({ pageVisibility: {} });
    }
    if (String(input) === "/api/filters") {
      return mockJsonResponse({ enterprises: [] });
    }
    throw new Error(`Unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <SidebarProvider>
      <SidebarHarness />
    </SidebarProvider>,
  );

  const sidebar = document.getElementById("sidebar-nav");
  if (!sidebar) throw new Error("sidebar-nav was not rendered");
  return sidebar;
}

beforeEach(() => {
  mockState.pathname = "/dashboard";
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Sidebar mobile accessibility", () => {
  it("removes the closed mobile drawer from keyboard and assistive technology", async () => {
    stubMatchMedia(true);

    const sidebar = renderSidebar();

    await waitFor(() => {
      expect(sidebar).toHaveAttribute("inert");
      expect(sidebar).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("restores the open mobile drawer to the tab order and moves focus inside it", async () => {
    stubMatchMedia(true);

    const sidebar = renderSidebar();

    await waitFor(() => expect(sidebar).toHaveAttribute("inert"));

    fireEvent.click(screen.getByRole("button", { name: "Open test navigation" }));

    await waitFor(() => {
      expect(sidebar).not.toHaveAttribute("inert");
      expect(sidebar).not.toHaveAttribute("aria-hidden");
      expect(sidebar.contains(document.activeElement)).toBe(true);
    });
  });

  it("keeps Tab focus inside the open mobile drawer", async () => {
    stubMatchMedia(true);

    const sidebar = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Open test navigation" }));
    await screen.findByText("Overview");

    // Derive the boundaries from the live DOM rather than hardcoding nav labels,
    // so reordering or adding navigation entries cannot silently break the trap.
    const focusable = Array.from(
      sidebar.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.closest('[aria-hidden="true"], [inert]'));

    expect(focusable.length).toBeGreaterThan(1);
    const firstFocusable = focusable[0];
    const lastFocusable = focusable[focusable.length - 1];

    lastFocusable.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(firstFocusable);

    firstFocusable.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastFocusable);
  });

  it("never makes the desktop sidebar inert when the mobile drawer state is closed", async () => {
    stubMatchMedia(false);

    const sidebar = renderSidebar();

    await waitFor(() => {
      expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
    });
    expect(sidebar).not.toHaveAttribute("inert");
    expect(sidebar).not.toHaveAttribute("aria-hidden");
  });
});
