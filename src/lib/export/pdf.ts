/**
 * PDF export via html2canvas + jsPDF.
 * Captures DOM sections individually and lays them out in a multi-page PDF.
 */
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
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

  // Capture each section
  for (const section of sections) {
    const canvas = await html2canvas(section, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: null,
    });

    const imgData = canvas.toDataURL("image/png");
    const imgAspect = canvas.width / canvas.height;

    // Release canvas memory immediately
    canvas.width = 0;
    canvas.height = 0;

    const imgWidth = CONTENT_WIDTH;
    const imgHeight = imgWidth / imgAspect;

    // If image doesn't fit on current page, start a new page
    if (yOffset + imgHeight > A4_HEIGHT_PT - MARGIN) {
      pdf.addPage();
      yOffset = MARGIN;
    }

    pdf.addImage(imgData, "PNG", MARGIN, yOffset, imgWidth, imgHeight);
    yOffset += imgHeight + 15; // 15pt gap between sections
  }

  const pdfBlob = pdf.output("blob");
  const safeName = (filename || title.toLowerCase().replace(/\s+/g, "-")) + ".pdf";
  triggerDownload(pdfBlob, safeName, "application/pdf");
}
