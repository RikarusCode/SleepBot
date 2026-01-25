// src/db.js
const Database = require("better-sqlite3");

function initDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('GN','GM','RATING')),
      ts_utc TEXT NOT NULL,
      raw_content TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_checkins_user_time
      ON checkins(user_id, ts_utc);

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      bed_ts_utc TEXT NOT NULL,
      wake_ts_utc TEXT,
      sleep_minutes INTEGER,
      rating_1_10 INTEGER,
      rating_status TEXT NOT NULL CHECK(rating_status IN ('MISSING','RECORDED','OMITTED')),
      status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_status
      ON sessions(user_id, status);
  `);

  const insertCheckin = db.prepare(`
    INSERT INTO checkins (user_id, username, kind, ts_utc, raw_content)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getOpenSession = db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ? AND status = 'OPEN'
    ORDER BY id DESC
    LIMIT 1
  `);

  const createSession = db.prepare(`
    INSERT INTO sessions (user_id, username, bed_ts_utc, rating_status, status)
    VALUES (?, ?, ?, 'MISSING', 'OPEN')
  `);

  const closeSession = db.prepare(`
    UPDATE sessions
    SET wake_ts_utc = ?, sleep_minutes = ?, status = 'CLOSED'
    WHERE id = ?
  `);

  const setRating = db.prepare(`
    UPDATE sessions
    SET rating_1_10 = ?, rating_status = 'RECORDED'
    WHERE id = ?
  `);

  const omitRatingForOpenOrLastClosed = db.prepare(`
    UPDATE sessions
    SET rating_status = 'OMITTED'
    WHERE id = ?
  `);

  const lastSessionNeedingRating = db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ? AND rating_status = 'MISSING'
    ORDER BY id DESC
    LIMIT 1
  `);

  const lastSession = db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);

  const listSessionsForExport = db.prepare(`
    SELECT
      user_id,
      username,
      bed_ts_utc,
      wake_ts_utc,
      sleep_minutes,
      rating_1_10,
      rating_status
    FROM sessions
    WHERE status = 'CLOSED'
    ORDER BY bed_ts_utc ASC
  `);

  return {
    recordCheckin(userId, username, kind, isoUtc, raw) {
      insertCheckin.run(userId, username, kind, isoUtc, raw);
    },

    getOpenSession(userId) {
      return getOpenSession.get(userId) || null;
    },

    createSession(userId, username, bedIsoUtc) {
      const info = createSession.run(userId, username, bedIsoUtc);
      return info.lastInsertRowid;
    },

    closeSession(sessionId, wakeIsoUtc, sleepMinutes) {
      closeSession.run(wakeIsoUtc, sleepMinutes, sessionId);
    },

    lastSessionNeedingRating(userId) {
      return lastSessionNeedingRating.get(userId) || null;
    },

    setRating(sessionId, rating) {
      setRating.run(rating, sessionId);
    },

    lastSession(userId) {
      return lastSession.get(userId) || null;
    },

    omitRating(sessionId) {
      omitRatingForOpenOrLastClosed.run(sessionId);
    },

    sessionsForExport() {
      return listSessionsForExport.all();
    },

    close() {
      db.close();
    },
  };
}

module.exports = { initDb };
