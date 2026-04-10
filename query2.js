const db = require('better-sqlite3')('./data/copilot-metrics.db');

// Check copilot_seats
const seatsCount = db.prepare('SELECT COUNT(*) as cnt FROM copilot_seats').get().cnt;
console.log('--- copilot_seats (' + seatsCount + ' rows) ---');
const seats = db.prepare('SELECT * FROM copilot_seats LIMIT 3').all();
console.log(JSON.stringify(seats, null, 2));

// Check team_memberships
const teamCount = db.prepare('SELECT COUNT(*) as cnt FROM team_memberships').get().cnt;
console.log('\n--- team_memberships (' + teamCount + ' rows) ---');
const teams = db.prepare('SELECT * FROM team_memberships LIMIT 3').all();
console.log(JSON.stringify(teams, null, 2));

// Check sync_log
const syncCount = db.prepare('SELECT COUNT(*) as cnt FROM sync_log').get().cnt;
console.log('\n--- sync_log (' + syncCount + ' rows) ---');
const syncs = db.prepare('SELECT * FROM sync_log LIMIT 3').all();
console.log(JSON.stringify(syncs, null, 2));

// Check sync_lock
const lockCount = db.prepare('SELECT COUNT(*) as cnt FROM sync_lock').get().cnt;
console.log('\n--- sync_lock (' + lockCount + ' rows) ---');
const locks = db.prepare('SELECT * FROM sync_lock LIMIT 3').all();
console.log(JSON.stringify(locks, null, 2));

db.close();
