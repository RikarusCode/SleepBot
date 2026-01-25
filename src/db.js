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

    CREATE INDEX IF NOT EXISTS idx_sessions_user_time
      ON sessions(user_id, bed_ts_utc);

    -- Guard table to prevent multiple !reset last from rolling back multiple points
    -- NOTE: this now guards by checkin id (last action), not session id.
    CREATE TABLE IF NOT EXISTS reset_state (
      user_id TEXT PRIMARY KEY,
      last_reset_checkin_id INTEGER
    );
  `);

  // ---------------- Core statements ----------------

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

  const lastSession = db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);

  const lastSessionNeedingRating = db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ? AND rating_status = 'MISSING'
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

  const reopenSession = db.prepare(`
    UPDATE sessions
    SET wake_ts_utc = NULL,
        sleep_minutes = NULL,
        status = 'OPEN'
    WHERE id = ?
  `);

  const setRating = db.prepare(`
    UPDATE sessions
    SET rating_1_10 = ?, rating_status = 'RECORDED'
    WHERE id = ?
  `);

  const clearRating = db.prepare(`
    UPDATE sessions
    SET rating_1_10 = NULL,
        rating_status = 'MISSING'
    WHERE id = ?
  `);

  const omitRating = db.prepare(`
    UPDATE sessions
    SET rating_status = 'OMITTED'
    WHERE id = ?
  `);

  const deleteSessionById = db.prepare(`
    DELETE FROM sessions WHERE id = ?
  `);

  const sessionsForExport = db.prepare(`
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

  // ---------------- Reset helpers (checkin-level) ----------------

  const lastCheckin = db.prepare(`
    SELECT * FROM checkins
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);

  const deleteCheckinById = db.prepare(`
    DELETE FROM checkins WHERE id = ?
  `);

  const getResetState = db.prepare(`
    SELECT last_reset_checkin_id FROM reset_state WHERE user_id = ?
  `);

  const setResetState = db.prepare(`
    INSERT INTO reset_state (user_id, last_reset_checkin_id)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_reset_checkin_id = excluded.last_reset_checkin_id
  `);

  // ---------------- Wipe all ----------------

  const wipeAllSessions = db.prepare(`DELETE FROM sessions`);
  const wipeAllCheckins = db.prepare(`DELETE FROM checkins`);
  const wipeResetState = db.prepare(`DELETE FROM reset_state`);

  return {
    // ----- existing API -----
    recordCheckin(userId, username, kind, isoUtc, raw) {
      insertCheckin.run(userId, username, kind, isoUtc, raw);
    },

    getOpenSession(userId) {
      return getOpenSession.get(userId) || null;
    },

    lastSession(userId) {
      return lastSession.get(userId) || null;
    },

    lastSessionNeedingRating(userId) {
      return lastSessionNeedingRating.get(userId) || null;
    },

    createSession(userId, username, bedIsoUtc) {
      const info = createSession.run(userId, username, bedIsoUtc);
      return Number(info.lastInsertRowid);
    },

    closeSession(sessionId, wakeIsoUtc, sleepMinutes) {
      closeSession.run(wakeIsoUtc, sleepMinutes, sessionId);
    },

    setRating(sessionId, rating) {
      setRating.run(rating, sessionId);
    },

    omitRating(sessionId) {
      omitRating.run(sessionId);
    },

    sessionsForExport() {
      return sessionsForExport.all();
    },

    // ----- NEW API for “reset last entry” semantics -----

    lastCheckin(userId) {
      return lastCheckin.get(userId) || null;
    },

    getLastResetCheckinId(userId) {
      const row = getResetState.get(userId);
      return row ? row.last_reset_checkin_id : null;
    },

    setLastResetCheckinId(userId, checkinId) {
      setResetState.run(userId, checkinId);
    },

    deleteCheckin(checkinId) {
      deleteCheckinById.run(checkinId);
    },

    // Undo helpers used by index.js
    reopenSession(sessionId) {
      reopenSession.run(sessionId);
    },

    deleteSession(sessionId) {
      deleteSessionById.run(sessionId);
    },

    clearRating(sessionId) {
      clearRating.run(sessionId);
    },

    // Keep your old “reset all” for admin
    wipeAll() {
      db.transaction(() => {
        wipeAllSessions.run();
        wipeAllCheckins.run();
        wipeResetState.run();
      })();
    },

    close() {
      db.close();
    },
  };
}

module.exports = { initDb };
