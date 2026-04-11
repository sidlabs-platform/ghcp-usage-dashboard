// SQLite database setup using better-sqlite3

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "copilot-metrics.db");
const SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
const GHAS_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "ghas-schema.sql");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Run schema migrations
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  _db.exec(schema);

  // GHAS schema
  const ghasSchema = fs.readFileSync(GHAS_SCHEMA_PATH, "utf-8");
  _db.exec(ghasSchema);

  // Add columns introduced after initial schema (safe if already present)
  const migrations = [
    "ALTER TABLE user_daily_metrics ADD COLUMN used_copilot_coding_agent INTEGER DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { _db.exec(sql); } catch { /* column already exists */ }
  }

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
