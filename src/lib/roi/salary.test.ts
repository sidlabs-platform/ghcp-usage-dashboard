/**
 * @vitest-environment jsdom
 *
 * Needs a DOM because the persistence helpers read/write `window.localStorage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANNUAL_SALARY,
  MAX_ANNUAL_SALARY,
  SALARY_STORAGE_KEY,
  normalizeSalary,
  payrollPercent,
  readStoredSalary,
  writeStoredSalary,
} from "./salary";

describe("normalizeSalary", () => {
  it("accepts positive numeric and numeric-string values", () => {
    expect(normalizeSalary(150000)).toBe(150000);
    expect(normalizeSalary("175000")).toBe(175000);
  });

  it("rejects unusable values", () => {
    expect(normalizeSalary(null)).toBeNull();
    expect(normalizeSalary(undefined)).toBeNull();
    expect(normalizeSalary("")).toBeNull();
    expect(normalizeSalary("not-a-number")).toBeNull();
    expect(normalizeSalary(NaN)).toBeNull();
    expect(normalizeSalary(Infinity)).toBeNull();
    expect(normalizeSalary(0)).toBeNull();
    expect(normalizeSalary(-100)).toBeNull();
    expect(normalizeSalary(MAX_ANNUAL_SALARY + 1)).toBeNull();
  });

  it("accepts the exact upper bound", () => {
    expect(normalizeSalary(MAX_ANNUAL_SALARY)).toBe(MAX_ANNUAL_SALARY);
  });
});

describe("payrollPercent", () => {
  it("expresses monthly cost as a share of monthly compensation", () => {
    // $60/month against $120,000/yr ($10,000/month) is 0.6%.
    expect(payrollPercent(60, 120000)).toBeCloseTo(0.6, 6);
  });

  it("returns null when the salary is unusable", () => {
    expect(payrollPercent(60, 0)).toBeNull();
    expect(payrollPercent(60, -1)).toBeNull();
    expect(payrollPercent(60, NaN)).toBeNull();
  });

  it("returns null when the cost is not finite", () => {
    expect(payrollPercent(NaN, 150000)).toBeNull();
  });
});

describe("salary persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("round-trips a stored salary", () => {
    writeStoredSalary(175000);
    expect(readStoredSalary()).toBe(175000);
  });

  it("falls back to the default for corrupt stored values", () => {
    window.localStorage.setItem(SALARY_STORAGE_KEY, "banana");
    expect(readStoredSalary()).toBe(DEFAULT_ANNUAL_SALARY);

    window.localStorage.setItem(SALARY_STORAGE_KEY, "-5000");
    expect(readStoredSalary()).toBe(DEFAULT_ANNUAL_SALARY);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(readStoredSalary()).toBe(DEFAULT_ANNUAL_SALARY);
  });

  it("never persists an invalid value", () => {
    writeStoredSalary(-1);
    expect(window.localStorage.getItem(SALARY_STORAGE_KEY)).toBeNull();
  });

  it("survives localStorage throwing (private browsing)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredSalary()).toBe(DEFAULT_ANNUAL_SALARY);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeStoredSalary(150000)).not.toThrow();
  });
});
