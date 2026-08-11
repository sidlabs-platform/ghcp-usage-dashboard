// One-time backfill: `ai-credits` billing rows store the AI-credit amount in the
// legacy quantity/gross_amount columns while the aic_quantity/aic_gross_amount
// columns (read by the reconciliation and AI-credit pages) were left at 0 —
// either because they predate those columns or the CSV omitted them. Copy the
// values across. Idempotent: only touches rows still at aic_quantity=0.
// Usage: node --experimental-sqlite scripts/backfill-aic-quantity.mjs [dbPath]
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] || ".next/standalone/data/copilot-metrics.db";
const db = new DatabaseSync(path);
console.log("DB:", path);

const before = db
  .prepare(
    `SELECT COUNT(*) rows, ROUND(COALESCE(SUM(quantity),0),2) qty
     FROM billing_premium_requests
     WHERE unit_type='ai-credits' AND aic_quantity = 0 AND quantity > 0`,
  )
  .get();
console.log("Candidates (ai-credits rows, aic_quantity=0, quantity>0):", JSON.stringify(before));

const res = db
  .prepare(
    `UPDATE billing_premium_requests
     SET aic_quantity = quantity,
         aic_gross_amount = gross_amount
     WHERE unit_type='ai-credits' AND aic_quantity = 0 AND quantity > 0`,
  )
  .run();
console.log("Rows updated:", res.changes);

const after = db
  .prepare(
    `SELECT enterprise_slug es, COUNT(*) rows, MIN(date) mn, MAX(date) mx,
            ROUND(COALESCE(SUM(aic_quantity),0),2) aic, ROUND(COALESCE(SUM(aic_gross_amount),0),2) usd
     FROM billing_premium_requests WHERE unit_type='ai-credits' GROUP BY es`,
  )
  .all();
console.log("After (ai-credits rows by enterprise):");
for (const r of after) console.log(" ", JSON.stringify(r));
db.close();
