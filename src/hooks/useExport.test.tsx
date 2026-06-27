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
    vi.unstubAllGlobals();
  });

  it("downloads server-side user exports via fetch and blob", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const csvBlob = new Blob(["User\nalice"], { type: "text/csv;charset=utf-8" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({
        "Content-Disposition": 'attachment; filename="copilot-users-export-2024-01-01-to-2024-01-07.csv"',
        "Content-Type": "text/csv;charset=utf-8",
      }),
      blob: () => Promise.resolve(csvBlob),
    }));
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

    expect(fetch).toHaveBeenCalledWith("/api/export/users?days=7&teams=eng");
    expect(mockState.fetchAllPages).not.toHaveBeenCalled();
    expect(mockState.triggerDownload).toHaveBeenCalledWith(
      csvBlob,
      "copilot-users-export-2024-01-01-to-2024-01-07.csv",
      "text/csv;charset=utf-8",
    );
    expect(mockState.triggerDownloadFromUrl).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(result.current.exporting).toBeNull();
  });

  it("surfaces server-side export failures before downloading", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const errorResponse = {
      error: "Request timed out. Try a narrower date range or add filters.",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: () => Promise.resolve(JSON.stringify(errorResponse)),
      json: () => Promise.resolve(errorResponse),
    }));
    const { result } = renderHook(() => useExport());

    await act(async () => {
      await result.current.exportCSV({
        fetchUrl: "/api/users",
        extraParams: new URLSearchParams([["days", "7"]]),
        columns: [{ key: "login", label: "User" }],
        dataExtractor: (json) => (json as { users?: unknown[] }).users ?? [],
        filename: "users-export-7d",
      });
    });

    expect(fetch).toHaveBeenCalledWith("/api/export/users?days=7");
    expect(mockState.triggerDownload).not.toHaveBeenCalled();
    expect(mockState.triggerDownloadFromUrl).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      "Export failed: Request timed out. Try a narrower date range or add filters.",
    );
    expect(result.current.exporting).toBeNull();
  });

  it("surfaces stream failures while reading the export blob", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Type": "text/csv;charset=utf-8" }),
      blob: () => Promise.reject(new Error("Export timed out. Try a narrower date range or add filters.")),
    }));
    const { result } = renderHook(() => useExport());

    await act(async () => {
      await result.current.exportCSV({
        fetchUrl: "/api/users",
        extraParams: new URLSearchParams([["days", "7"]]),
        columns: [{ key: "login", label: "User" }],
        dataExtractor: (json) => (json as { users?: unknown[] }).users ?? [],
        filename: "users-export-7d",
      });
    });

    expect(fetch).toHaveBeenCalledWith("/api/export/users?days=7");
    expect(mockState.triggerDownload).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      "Export failed: Export timed out. Try a narrower date range or add filters.",
    );
    expect(result.current.exporting).toBeNull();
  });
});
