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
