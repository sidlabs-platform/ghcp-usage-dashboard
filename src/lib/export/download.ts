/**
 * Browser file download utility.
 * Creates a temporary anchor element to trigger download.
 */
export function triggerDownload(
  content: string | Blob,
  filename: string,
  mimeType: string = "text/plain",
): void {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Trigger a file download from a URL without replacing the current page.
 */
export function triggerDownloadFromUrl(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
