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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { exporting, exportCSV, exportPDF } = useExport();

  // Focus first menu item when menu opens
  useEffect(() => {
    if (open && menuRef.current) {
      // Small timeout ensures the DOM has updated
      setTimeout(() => {
        const firstItem = menuRef.current?.querySelector('[role="menuitem"]') as HTMLElement;
        firstItem?.focus();
      }, 0);
    }
  }, [open]);

  // Close menu on outside click or Escape key, handle arrow navigation
  useEffect(() => {
    if (!open) return;
    const handleDocumentClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      
      // Only handle navigation if focus is in our menu or on the trigger
      const isActiveInMenu = 
        menuRef.current?.contains(document.activeElement) || 
        triggerRef.current === document.activeElement;

      if (!isActiveInMenu) return;

      // Arrow key and Home/End navigation within menu
      if (open && menuRef.current && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const items = Array.from(menuRef.current.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
        if (items.length === 0) return;
        
        const currentIndex = items.indexOf(document.activeElement as HTMLElement);
        
        if (e.key === "ArrowDown") {
          const nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
          items[nextIndex]?.focus();
        } else if (e.key === "ArrowUp") {
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
          items[prevIndex]?.focus();
        } else if (e.key === "Home") {
          items[0]?.focus();
        } else if (e.key === "End") {
          items[items.length - 1]?.focus();
        }
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
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
        type="button"
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
        type="button"
        ref={triggerRef}
        variant="outline"
        size="sm"
        onClick={() => setOpen((prev) => !prev)}
        disabled={!isReady || !!exporting}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {exporting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Download className="h-4 w-4 mr-2" />
        )}
        {exporting ? "Exporting…" : "Export"}
      </Button>

      {open && (
        <div 
          className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border bg-[hsl(var(--background))] p-1 shadow-md"
          role="menu"
          aria-orientation="vertical"
        >
          {csv && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={handleCSV}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))] focus-visible:bg-[hsl(var(--accent))] focus-visible:text-[hsl(var(--accent-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))]"
            >
              <Table className="h-4 w-4" />
              Export as CSV
            </button>
          )}
          {pdf && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={handlePDF}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))] focus-visible:bg-[hsl(var(--accent))] focus-visible:text-[hsl(var(--accent-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))]"
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
