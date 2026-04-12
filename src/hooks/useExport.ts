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

export function useExport() {
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  const exportCSV = useCallback(async (config: ExportCSVConfig) => {
    setExporting("csv");
    try {
      const allData = await fetchAllPages(
        config.fetchUrl,
        config.extraParams,
        config.dataExtractor,
      );
      const csvString = arrayToCSV(allData, config.columns, config.metadata);
      triggerDownload(csvString, `${config.filename}.csv`, "text/csv;charset=utf-8");
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
