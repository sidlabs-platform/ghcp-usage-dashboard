const db = require('better-sqlite3')('./data/copilot-metrics.db');

// List tables
console.log('=== TABLES ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
tables.forEach(t => console.log('- ' + t.name));

console.log('\n=== SCHEMAS ===');
const schemas = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
schemas.forEach(t => {
  console.log('\n--- ' + t.name + ' ---');
  console.log(t.sql);
});

// Sample data from each table
console.log('\n=== SAMPLE DATA ===');
tables.forEach(t => {
  const tableName = t.name;
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${tableName}`).get().cnt;
  console.log(`\n--- ${tableName} (${count} rows) ---`);
  const rows = db.prepare(`SELECT * FROM ${tableName} LIMIT 3`).all();
  console.log(JSON.stringify(rows, null, 2));
});

db.close();
