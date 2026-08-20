// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateRangeProvider, useDateRange } from "./DateRangeContext";

const router = { replace: vi.fn() };
const searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => router,
  usePathname: () => "/dashboard",
}));

function DateRangeProbe() {
  const { endDate, setMonth } = useDateRange();
  return (
    <>
      <span>{endDate}</span>
      <button type="button" onClick={() => setMonth("2026-08")}>Select month</button>
    </>
  );
}

describe("DateRangeProvider month mode", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    router.replace.mockReset();
  });

  it("ends the current usage month on yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));

    render(
      <DateRangeProvider>
        <DateRangeProbe />
      </DateRangeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select month" }));
    expect(screen.getByText("2026-08-19")).toBeInTheDocument();
  });
});
