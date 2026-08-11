/**
 * Salary-band modeling input for the Potential ROI section.
 *
 * The selected compensation figure is a modeling assumption, not payroll data —
 * it only ever lives in the browser (localStorage) and is never sent to the API.
 */

export const SALARY_STORAGE_KEY = "ghcp:roi:annualSalary";

/** Preset annual compensation bands offered in the selector. */
export const SALARY_BANDS = [100_000, 125_000, 150_000, 175_000, 200_000, 250_000] as const;

/** Band used when nothing is stored, or when the stored value is unusable. */
export const DEFAULT_ANNUAL_SALARY = 150_000;

/** Upper bound guarding against absurd or accidental input. */
export const MAX_ANNUAL_SALARY = 10_000_000;

/**
 * Coerce an arbitrary stored/typed value into a usable annual salary.
 * Returns `null` for anything non-finite, non-positive, or out of range so
 * callers can fall back to {@link DEFAULT_ANNUAL_SALARY}.
 */
export function normalizeSalary(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_ANNUAL_SALARY) return null;
  return n;
}

/**
 * Read the persisted salary. Safe during SSR (no `window`) and resilient to
 * corrupt, NaN, or negative stored values.
 */
export function readStoredSalary(): number {
  if (typeof window === "undefined") return DEFAULT_ANNUAL_SALARY;
  try {
    return normalizeSalary(window.localStorage.getItem(SALARY_STORAGE_KEY)) ?? DEFAULT_ANNUAL_SALARY;
  } catch {
    // localStorage can throw in private-browsing / blocked-cookie modes.
    return DEFAULT_ANNUAL_SALARY;
  }
}

/** Persist the salary, ignoring storage failures. */
export function writeStoredSalary(value: number): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeSalary(value);
  if (normalized === null) return;
  try {
    window.localStorage.setItem(SALARY_STORAGE_KEY, String(normalized));
  } catch {
    // Non-fatal — the selection simply won't survive a reload.
  }
}

/**
 * Monthly cost expressed as a percentage of monthly compensation.
 * Returns `null` when the salary is unusable, so the UI can render "—".
 */
export function payrollPercent(costPerMonth: number, annualSalary: number): number | null {
  const salary = normalizeSalary(annualSalary);
  if (salary === null || !Number.isFinite(costPerMonth)) return null;
  return (costPerMonth / (salary / 12)) * 100;
}
