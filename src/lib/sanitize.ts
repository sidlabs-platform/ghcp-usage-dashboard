/**
 * Sanitizes a string for safe inclusion in log output.
 * Strips newlines, carriage returns, null bytes, and other control characters
 * that could be used for log injection/forging attacks.
 */
export function sanitizeForLog(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}
