/**
 * PDF export via dom-to-image-more + jsPDF.
 * Captures DOM sections individually and lays them out in a multi-page PDF.
 * Uses dom-to-image-more for better CSS support than html2canvas.
 */
import { jsPDF } from "jspdf";
import domtoimage from "dom-to-image-more";
import type { ExportMetadata } from "./csv";
import { triggerDownload } from "./download";

const A4_WIDTH_PT = 841.89; // A4 landscape width in points
const A4_HEIGHT_PT = 595.28; // A4 landscape height in points
const MARGIN = 30;
const CONTENT_WIDTH = A4_WIDTH_PT - 2 * MARGIN;
const CONTENT_HEIGHT = A4_HEIGHT_PT - 2 * MARGIN;
const METADATA_HEIGHT = 60;

/**
 * Capture an array of DOM elements section-by-section and generate a PDF.
 */
export async function captureSectionsAsPDF(
  sections: HTMLElement[],
  title: string,
  metadata?: ExportMetadata,
  filename?: string,
): Promise<void> {
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

  // Add metadata header on first page
  let yOffset = MARGIN;
  pdf.setFontSize(16);
  pdf.setTextColor(30, 30, 30);
  pdf.text(title, MARGIN, yOffset + 14);
  yOffset += 22;

  if (metadata) {
    pdf.setFontSize(9);
    pdf.setTextColor(100, 100, 100);
    const metaParts: string[] = [];
    if (metadata.dateRange) metaParts.push(`Date Range: ${metadata.dateRange}`);
    if (metadata.teams) metaParts.push(`Teams: ${metadata.teams}`);
    if (metadata.orgs) metaParts.push(`Organizations: ${metadata.orgs}`);
    metaParts.push(`Exported: ${new Date().toLocaleString()}`);
    pdf.text(metaParts.join("  |  "), MARGIN, yOffset + 10);
    yOffset += 18;
  }

  yOffset += METADATA_HEIGHT - 40; // space after metadata

  // Detect the current page background color to match the active theme
  const pageBackgroundColor = window.getComputedStyle(document.documentElement).backgroundColor;
  const bgcolor = pageBackgroundColor === "rgba(0, 0, 0, 0)" ? "#ffffff" : pageBackgroundColor;

  // Capture each section
  for (const section of sections) {
    // Determine target dimensions based on actual DOM size multiplied by scale factor
    // This gives us higher resolution than regular capture
    const scale = 2;
    const width = section.offsetWidth * scale;
    const height = section.offsetHeight * scale;
    
    // Clone the element to capture it with a consistent background
    // This ensures exported PDFs match the current theme without flicker
    const cloneWrapper = document.createElement("div");
    cloneWrapper.style.position = "absolute";
    cloneWrapper.style.left = "-9999px";
    cloneWrapper.style.top = "-9999px";
    cloneWrapper.style.backgroundColor = bgcolor;
    
    const clone = section.cloneNode(true) as HTMLElement;
    cloneWrapper.appendChild(clone);
    document.body.appendChild(cloneWrapper);
    
    try {
      const imgData = await domtoimage.toPng(clone, {
        width: width,
        height: height,
        style: {
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          width: `${section.offsetWidth}px`,
          height: `${section.offsetHeight}px`,
        },
        bgcolor: bgcolor
      });
      
      // Calculate dimensions to maintain aspect ratio
      const imgAspect = width / height;
      const imgWidth = CONTENT_WIDTH;
      const imgHeight = imgWidth / imgAspect;

      // If image doesn't fit on current page, start a new page
      if (yOffset + imgHeight > A4_HEIGHT_PT - MARGIN) {
        pdf.addPage();
        yOffset = MARGIN;
      }

      pdf.addImage(imgData, "PNG", MARGIN, yOffset, imgWidth, imgHeight);
      yOffset += imgHeight + 15; // 15pt gap between sections
    } finally {
      // Clean up DOM
      document.body.removeChild(cloneWrapper);
    }
  }

  const pdfBlob = pdf.output("blob");
  const safeName = (filename || title.toLowerCase().replace(/\s+/g, "-")) + ".pdf";
  triggerDownload(pdfBlob, safeName, "application/pdf");
}
