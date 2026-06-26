// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useExport } from "./useExport";

const mockState = vi.hoisted(() => ({
  fetchAllPages: vi.fn(),
  arrayToCSV: vi.fn(() => ""),
  triggerDownload: vi.fn(),
  triggerDownloadFromUrl: vi.fn(),
  captureSectionsAsPDF: vi.fn(),
}));

vi.mock("@/lib/export/csv", () => ({
  arrayToCSV: mockState.arrayToCSV,
  fetchAllPages: mockState.fetchAllPages,
}));

vi.mock("@/lib/export/download", () => ({
  triggerDownload: mockState.triggerDownload,
  triggerDownloadFromUrl: mockState.triggerDownloadFromUrl,
}));

vi.mock("@/lib/export/pdf", () => ({
  captureSectionsAsPDF: mockState.captureSectionsAsPDF,
}));

describe("useExport", () => {
  beforeEach(() => {
    mockState.fetchAllPages.mockReset();
    mockState.arrayToCSV.mockReset();
    mockState.triggerDownload.mockReset();
    mockState.triggerDownloadFromUrl.mockReset();
    mockState.captureSectionsAsPDF.mockReset();
  });

  it("uses a background download trigger for server-side user exports", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const { result } = renderHook(() => useExport());

    await act(async () => {
      await result.current.exportCSV({
        fetchUrl: "/api/users",
        extraParams: new URLSearchParams([
          ["days", "7"],
          ["teams", "eng"],
        ]),
        columns: [{ key: "login", label: "User" }],
        dataExtractor: (json) => (json as { users?: unknown[] }).users ?? [],
        filename: "users-export-7d",
      });
    });

    expect(mockState.triggerDownloadFromUrl).toHaveBeenCalledWith("/api/export/users?days=7&teams=eng");
    expect(mockState.fetchAllPages).not.toHaveBeenCalled();
    expect(mockState.triggerDownload).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(result.current.exporting).toBeNull();
  });
});
