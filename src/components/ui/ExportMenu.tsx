"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Download, FileText, Table, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useExport, type ExportCSVConfig, type ExportPDFConfig } from "@/hooks/useExport";

interface ExportMenuProps {
  /** CSV export config — if provided, CSV option is shown */
  csv?: ExportCSVConfig;
  /** PDF export config — if provided, PDF option is shown */
  pdf?: ExportPDFConfig;
  /** Disable export when data is still loading */
  isReady?: boolean;
}

export function ExportMenu({ csv, pdf, isReady = true }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { exporting, exportCSV, exportPDF } = useExport();

  // Close menu on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleCSV = useCallback(async () => {
    if (!csv) return;
    setOpen(false);
    await exportCSV(csv);
  }, [csv, exportCSV]);

  const handlePDF = useCallback(async () => {
    if (!pdf) return;
    setOpen(false);
    await exportPDF(pdf);
  }, [pdf, exportPDF]);

  const hasOptions = !!(csv || pdf);
  if (!hasOptions) return null;

  // If only one format is available, make it a direct button (no dropdown)
  const singleFormat = csv && !pdf ? "csv" : !csv && pdf ? "pdf" : null;

  if (singleFormat) {
    const handler = singleFormat === "csv" ? handleCSV : handlePDF;
    const label = singleFormat === "csv" ? "Export CSV" : "Export PDF";
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={handler}
        disabled={!isReady || !!exporting}
      >
        {exporting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Download className="h-4 w-4 mr-2" />
        )}
        {exporting ? "Exporting…" : label}
      </Button>
    );
  }

  // Multiple formats — show dropdown
  return (
    <div className="relative" ref={menuRef}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((prev) => !prev)}
        disabled={!isReady || !!exporting}
      >
        {exporting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Download className="h-4 w-4 mr-2" />
        )}
        {exporting ? "Exporting…" : "Export"}
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border bg-[hsl(var(--background))] p-1 shadow-md">
          {csv && (
            <button
              onClick={handleCSV}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]"
            >
              <Table className="h-4 w-4" />
              Export as CSV
            </button>
          )}
          {pdf && (
            <button
              onClick={handlePDF}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]"
            >
              <FileText className="h-4 w-4" />
              Export as PDF
            </button>
          )}
        </div>
      )}
    </div>
  );
}
