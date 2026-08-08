import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

import { importAicConsumptionCsv } from "./aic-csv-import";
import { ImportFileError } from "./import-shared";

const FIXTURE_DIR = path.join(process.cwd(), ".test-fixtures-aic-csv-import");

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const p = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("importAicConsumptionCsv — column aliases", () => {
  it.each(["premium_requests", "credits", "credits_consumed", "ai_credits", "quantity"])(
    "accepts the %s column as the credits alias",
    (alias) => {
      const p = writeFixture(
        `alias-${alias}.csv`,
        `period,org,user,${alias}\n2026-01,acme-org,alice,150\n`,
      );
      const result = importAicConsumptionCsv(p, { creditToUsd: 0.01 });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].credits).toBe(150);
      expect(result.warnings).toEqual([]);
      expect(result.skippedRows).toBe(0);
    },
  );

  it("prefers an explicit credits alias over another when multiple are present, using the first configured priority", () => {
    const p = writeFixture("multi-alias.csv", "period,org,user,credits,quantity\n2026-01,acme-org,alice,100,999\n");
    const result = importAicConsumptionCsv(p);
    expect(result.records[0].credits).toBe(100);
  });
});

describe("importAicConsumptionCsv — USD columns and fallback", () => {
  it("uses explicit gross/net USD columns when present", () => {
    const p = writeFixture(
      "usd-explicit.csv",
      "period,org,user,credits,gross_usd,net_usd\n2026-01,acme-org,alice,100,1.5,1.4\n",
    );
    const result = importAicConsumptionCsv(p, { creditToUsd: 0.02 });
    expect(result.records[0].grossUsd).toBe(1.5);
    expect(result.records[0].netUsd).toBe(1.4);
  });

  it("falls back to credits*creditToUsd only when gross USD is missing", () => {
    const p = writeFixture("usd-fallback.csv", "period,org,user,credits\n2026-01,acme-org,alice,200\n");
    const result = importAicConsumptionCsv(p, { creditToUsd: 0.02 });
    expect(result.records[0].grossUsd).toBe(4);
    expect(result.records[0].netUsd).toBeNull();
  });
});

describe("importAicConsumptionCsv — quoting, duplicates, missing values", () => {
  it("handles quoted fields with embedded commas and newlines", () => {
    const p = writeFixture(
      "quoted.csv",
      'period,org,user,credits\n2026-01,"acme, inc",alice,100\n2026-02,"multi\nline-org",bob,50\n',
    );
    const result = importAicConsumptionCsv(p);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].orgLogin).toBe("acme, inc");
    expect(result.records[1].orgLogin).toBe("multi\nline-org");
  });

  it("imports duplicate rows as separate records without deduplicating (dedup is an orchestration concern)", () => {
    const p = writeFixture(
      "duplicates.csv",
      "period,org,user,credits\n2026-01,acme-org,alice,100\n2026-01,acme-org,alice,100\n",
    );
    const result = importAicConsumptionCsv(p);
    expect(result.records).toHaveLength(2);
  });

  it("warns and skips a row with a missing/unparseable credits value instead of crashing", () => {
    const p = writeFixture(
      "missing-values.csv",
      "period,org,user,credits\n2026-01,acme-org,alice,\n2026-01,acme-org,bob,120\n",
    );
    const result = importAicConsumptionCsv(p);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].userLogin).toBe("bob");
    expect(result.skippedRows).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/credits/i);
  });

  it("warns about malformed rows (mismatched column counts) but still attempts to import them", () => {
    const p = writeFixture(
      "malformed-row.csv",
      "period,org,user,credits\n2026-01,acme-org,alice,100\n2026-02,acme-org\n2026-03,acme-org,carol,75\n",
    );
    const result = importAicConsumptionCsv(p);
    expect(result.warnings.some((w) => /malformed/i.test(w))).toBe(true);
    // Row 2 (2026-02,acme-org) has no user/credits — should be skipped as unparseable.
    expect(result.records.map((r) => r.userLogin)).toEqual(["alice", "carol"]);
    expect(result.skippedRows).toBe(1);
  });

  it("returns a valid empty ImportResult with a structured warning when the configured CSV path does not exist (optional source)", () => {
    const missingPath = path.join(FIXTURE_DIR, "missing.csv");
    const result = importAicConsumptionCsv(missingPath);
    expect(result.records).toEqual([]);
    expect(result.skippedRows).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/not found/i);
    expect(result.warnings[0]).toMatch(/missing\.csv/);
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a stable fingerprint across repeated calls when the configured CSV path is missing", () => {
    const missingPath = path.join(FIXTURE_DIR, "missing-repeat.csv");
    const r1 = importAicConsumptionCsv(missingPath);
    const r2 = importAicConsumptionCsv(missingPath);
    expect(r1.sourceFingerprint).toBe(r2.sourceFingerprint);
  });

  it("still throws ImportFileError for an oversized configured CSV file (not degraded to empty)", () => {
    const p = writeFixture("too-big.csv", "period,org,user,credits\n" + "2026-01,acme,alice,1\n".repeat(200));
    expect(() => importAicConsumptionCsv(p, { maxBytes: 50 })).toThrow(ImportFileError);
  });

  it("still throws ImportFileError when the configured CSV path is a directory (not degraded to empty — CSV config is single-file only)", () => {
    const dirPath = path.join(FIXTURE_DIR, "csv-as-directory");
    fs.mkdirSync(dirPath, { recursive: true });
    expect(() => importAicConsumptionCsv(dirPath)).toThrow(ImportFileError);
  });
});

describe("importAicConsumptionCsv — period/org/user normalization", () => {
  it("trims whitespace and lowercases user logins for consistent joins", () => {
    const p = writeFixture("normalize.csv", "period,org,user,credits\n 2026-01 , Acme-Org , Alice ,100\n");
    const result = importAicConsumptionCsv(p);
    expect(result.records[0].billingPeriod).toBe("2026-01");
    expect(result.records[0].orgLogin).toBe("Acme-Org");
    expect(result.records[0].userLogin).toBe("alice");
  });

  it("accepts a period column named 'month' or 'billing_period' as an alias", () => {
    const p1 = writeFixture("period-alias-month.csv", "month,org,user,credits\n2026-05,acme,alice,10\n");
    const r1 = importAicConsumptionCsv(p1);
    expect(r1.records[0].billingPeriod).toBe("2026-05");

    const p2 = writeFixture("period-alias-billing.csv", "billing_period,org,user,credits\n2026-06,acme,bob,20\n");
    const r2 = importAicConsumptionCsv(p2);
    expect(r2.records[0].billingPeriod).toBe("2026-06");
  });

  it("warns and skips a row with a malformed period", () => {
    const p = writeFixture("bad-period.csv", "period,org,user,credits\nnot-a-period,acme,alice,10\n2026-01,acme,bob,20\n");
    const result = importAicConsumptionCsv(p);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].userLogin).toBe("bob");
    expect(result.skippedRows).toBe(1);
    expect(result.warnings.some((w) => /period/i.test(w))).toBe(true);
  });
});

describe("importAicConsumptionCsv — fingerprint", () => {
  it("produces a stable fingerprint for unchanged file content", () => {
    const p = writeFixture("fingerprint-stable.csv", "period,org,user,credits\n2026-01,acme,alice,10\n");
    const r1 = importAicConsumptionCsv(p);
    const r2 = importAicConsumptionCsv(p);
    expect(r1.sourceFingerprint).toBe(r2.sourceFingerprint);
  });

  it("changes the fingerprint when file content changes", () => {
    const p = writeFixture("fingerprint-change.csv", "period,org,user,credits\n2026-01,acme,alice,10\n");
    const r1 = importAicConsumptionCsv(p);
    fs.writeFileSync(p, "period,org,user,credits\n2026-01,acme,alice,20\n", "utf-8");
    const r2 = importAicConsumptionCsv(p);
    expect(r1.sourceFingerprint).not.toBe(r2.sourceFingerprint);
  });
});
