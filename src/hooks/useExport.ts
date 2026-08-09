"use client";

import { useState, useCallback } from "react";
import { arrayToCSV, fetchAllPages, type CSVColumn, type ExportMetadata } from "@/lib/export/csv";
import { captureSectionsAsPDF } from "@/lib/export/pdf";
import { triggerDownload } from "@/lib/export/download";

export interface ExportCSVConfig {
  /** API endpoint base URL */
  fetchUrl: string;
  /** Query params (scope, days, search, etc.) — page-owned, includes local state */
  extraParams: URLSearchParams;
  /** Column definitions for CSV */
  columns: CSVColumn[];
  /** Data extractor from API response JSON */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dataExtractor: (json: any) => any[];
  /** Output filename (without extension) */
  filename: string;
  /** Filter metadata to include in CSV header */
  metadata?: ExportMetadata;
}

export interface ExportPDFConfig {
  /** Refs to DOM sections to capture (in order) */
  sectionRefs: React.RefObject<HTMLElement | null>[];
  /** Report title */
  title: string;
  /** Output filename (without extension) */
  filename: string;
  /** Filter metadata to include in PDF header */
  metadata?: ExportMetadata;
}

async function getExportErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("Content-Type") || "";
  const bodyText = await response.text().catch(() => "");

  if (contentType.includes("application/json")) {
    try {
      const json: unknown = JSON.parse(bodyText);
      if (
        json &&
        typeof json === "object" &&
        "error" in json &&
        typeof (json as { error?: unknown }).error === "string"
      ) {
        return (json as { error: string }).error;
      }
    } catch {
      // Fall through to returning the raw body text.
    }
  }

  return bodyText || `Export fetch failed: HTTP ${response.status}`;
}

function getDownloadFilename(
  contentDisposition: string | null,
  fallbackFilename: string,
): string {
  if (!contentDisposition) return fallbackFilename;

  const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (filenameStarMatch) {
    return decodeURIComponent(filenameStarMatch[1]);
  }

  const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  return filenameMatch?.[1] || fallbackFilename;
}

export function useExport() {
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  const exportCSV = useCallback(async (config: ExportCSVConfig) => {
    setExporting("csv");
    try {
      // Create new URLSearchParams for the export endpoint
      const params = new URLSearchParams(config.extraParams);
      
      // Determine correct export endpoint based on fetchUrl
      let exportUrl = config.fetchUrl;
      if (exportUrl.startsWith("/api/users")) {
          exportUrl = "/api/export/users";
      } else if (exportUrl.startsWith("/api/billing/license-reconciliation")) {
          // Server-side CSV export queries the repository directly with the
          // same period/view/scope/filter contract in a single bounded
          // request — never a client-side N-page loop.
          exportUrl = "/api/export/license-reconciliation";
      }
      
      // If we don't have a specific export endpoint, fallback to client-side data fetching
      if (!exportUrl.includes("/export/")) {
        const allData = await fetchAllPages(
          config.fetchUrl,
          config.extraParams,
          config.dataExtractor,
        );
        const csvString = arrayToCSV(allData, config.columns, config.metadata);
        triggerDownload(csvString, `${config.filename}.csv`, "text/csv;charset=utf-8");
        return;
      }

      // Use server-side export endpoint
      const url = `${exportUrl}?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(await getExportErrorMessage(response));
      }

      const blob = await response.blob();
      const filename = getDownloadFilename(
        response.headers.get("Content-Disposition"),
        `${config.filename}.csv`,
      );
      triggerDownload(
        blob,
        filename,
        response.headers.get("Content-Type") || "text/csv;charset=utf-8",
      );

    } catch (err) {
      console.error("CSV export failed:", err);
      alert(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setExporting(null);
    }
  }, []);

  const exportPDF = useCallback(async (config: ExportPDFConfig) => {
    setExporting("pdf");
    try {
      const sections = config.sectionRefs
        .map((ref) => ref.current)
        .filter((el): el is HTMLElement => el !== null);

      if (sections.length === 0) {
        throw new Error("No content sections found for PDF export");
      }

      await captureSectionsAsPDF(
        sections,
        config.title,
        config.metadata,
        config.filename,
      );
    } catch (err) {
      console.error("PDF export failed:", err);
      alert(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setExporting(null);
    }
  }, []);

  return { exporting, exportCSV, exportPDF };
}
