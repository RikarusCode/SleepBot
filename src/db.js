// src/db.js
const Database = require("better-sqlite3");

function initDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('GN','GM')),
      timestamp_utc TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_user_time
      ON events(user_id, timestamp_utc);
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (user_id, username, event_type, timestamp_utc)
    VALUES (?, ?, ?, ?)
  `);

  return {
    recordEvent(userId, username, eventType, isoUtc) {
      insertEvent.run(userId, username, eventType, isoUtc);
    },
    close() {
      db.close();
    },
  };
}

module.exports = { initDb };
