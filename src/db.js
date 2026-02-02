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
      morning_energy_rating INTEGER,
      status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
      note TEXT,
      gm_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_status
      ON sessions(user_id, status);

    CREATE INDEX IF NOT EXISTS idx_sessions_user_time
      ON sessions(user_id, bed_ts_utc);

    -- Add note column if it doesn't exist (migration for existing databases)
    -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we check first
    -- Using a pragma to check if column exists
  `);

  // Migration: Add note column to sessions table if it doesn't exist
  try {
    const tableInfo = db.pragma(`table_info(sessions)`);
    const hasNoteColumn = tableInfo.some(col => col.name === 'note');
    if (!hasNoteColumn) {
      db.exec(`ALTER TABLE sessions ADD COLUMN note TEXT`);
    }
  } catch (err) {
    // Table might not exist yet, that's okay
  }

  // Migration: Add note column to pending_gn table if it doesn't exist
  try {
    const tableInfo = db.pragma(`table_info(pending_gn)`);
    const hasNoteColumn = tableInfo.some(col => col.name === 'note');
    if (!hasNoteColumn) {
      db.exec(`ALTER TABLE pending_gn ADD COLUMN note TEXT`);
    }
  } catch (err) {
    // Table might not exist yet, that's okay
  }

  // Migration: Create weekly_summary_state table if it doesn't exist
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS weekly_summary_state (
        last_summary_date TEXT PRIMARY KEY
      );
    `);
  } catch (err) {
    // Ignore if already exists
  }

  // Migration: Add morning_energy_rating column to sessions table if it doesn't exist
  try {
    const tableInfo = db.pragma(`table_info(sessions)`);
    const hasMorningRatingColumn = tableInfo.some(col => col.name === 'morning_energy_rating');
    if (!hasMorningRatingColumn) {
      db.exec(`ALTER TABLE sessions ADD COLUMN morning_energy_rating INTEGER`);
    }
  } catch (err) {
    // Table might not exist yet, that's okay
  }

  // Migration: Add gm_note column to sessions table if it doesn't exist
  try {
    const tableInfo = db.pragma(`table_info(sessions)`);
    const hasGmNoteColumn = tableInfo.some(col => col.name === 'gm_note');
    if (!hasGmNoteColumn) {
      db.exec(`ALTER TABLE sessions ADD COLUMN gm_note TEXT`);
    }
  } catch (err) {
    // Table might not exist yet, that's okay
  }

  // Migration: Create undo_state table if it doesn't exist, or migrate old structure
  try {
    // Check if table exists and has old structure (user_id as primary key)
    const tableInfo = db.pragma(`table_info(undo_state)`);
    if (tableInfo.length === 0) {
      // Table doesn't exist, create new structure
      db.exec(`
        CREATE TABLE IF NOT EXISTS undo_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          checkin_id INTEGER,
          checkin_kind TEXT,
          checkin_ts_utc TEXT,
          checkin_raw_content TEXT,
          checkin_username TEXT,
          session_id INTEGER,
          session_data TEXT,
          undo_type TEXT,
          created_at_utc TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, checkin_id)
        );
      `);
    } else {
      // Table exists, check if it needs migration
      const hasIdColumn = tableInfo.some(col => col.name === 'id');
      if (!hasIdColumn) {
        // Migrate from old structure to new
        db.exec(`
          CREATE TABLE IF NOT EXISTS undo_state_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            checkin_id INTEGER,
            checkin_kind TEXT,
            checkin_ts_utc TEXT,
            checkin_raw_content TEXT,
            checkin_username TEXT,
            session_id INTEGER,
            session_data TEXT,
            undo_type TEXT,
            created_at_utc TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, checkin_id)
          );
        `);
        db.exec(`INSERT INTO undo_state_new SELECT NULL, user_id, checkin_id, checkin_kind, checkin_ts_utc, checkin_raw_content, checkin_username, session_id, session_data, undo_type, datetime('now') FROM undo_state;`);
        db.exec(`DROP TABLE undo_state;`);
        db.exec(`ALTER TABLE undo_state_new RENAME TO undo_state;`);
      }
    }
  } catch (err) {
    // Ignore if already exists or migration fails
    console.error("Error migrating undo_state table:", err);
  }

  db.exec(`
    -- Guard table to prevent multiple !reset last from rolling back multiple points
    -- NOTE: this now guards by checkin id (last action), not session id.
    CREATE TABLE IF NOT EXISTS reset_state (
      user_id TEXT PRIMARY KEY,
      last_reset_checkin_id INTEGER
    );

    -- Track pending GN checkins that were recorded but didn't create sessions
    -- (when user says gn while another session is open)
    CREATE TABLE IF NOT EXISTS pending_gn (
      user_id TEXT NOT NULL,
      checkin_id INTEGER NOT NULL,
      bed_ts_utc TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY (user_id, checkin_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pending_gn_time
      ON pending_gn(created_at_utc);

    -- Track when weekly summaries were last sent (to avoid duplicates)
    CREATE TABLE IF NOT EXISTS weekly_summary_state (
      last_summary_date TEXT PRIMARY KEY
    );

    -- Store undo data for reset operations (stack-based, multiple per user)
    CREATE TABLE IF NOT EXISTS undo_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      checkin_id INTEGER,
      checkin_kind TEXT,
      checkin_ts_utc TEXT,
      checkin_raw_content TEXT,
      checkin_username TEXT,
      session_id INTEGER,
      session_data TEXT,
      undo_type TEXT,
      created_at_utc TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, checkin_id)
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

  const getAllOpenSessions = db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ? AND status = 'OPEN'
    ORDER BY id DESC
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

  const lastSessionNeedingMorningRating = db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ? AND status = 'CLOSED' AND morning_energy_rating IS NULL
    ORDER BY id DESC
    LIMIT 1
  `);

  const setMorningRating = db.prepare(`
    UPDATE sessions
    SET morning_energy_rating = ?
    WHERE id = ?
  `);

  const createSession = db.prepare(`
    INSERT INTO sessions (user_id, username, bed_ts_utc, rating_status, status, note)
    VALUES (?, ?, ?, 'MISSING', 'OPEN', ?)
  `);

  const closeSession = db.prepare(`
    UPDATE sessions
    SET wake_ts_utc = ?, sleep_minutes = ?, status = 'CLOSED', morning_energy_rating = ?, gm_note = ?
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

  const updateSessionBedtime = db.prepare(`
    UPDATE sessions SET bed_ts_utc = ? WHERE id = ?
  `);

  const getCheckinsForSession = db.prepare(`
    SELECT c.* FROM checkins c
    INNER JOIN sessions s ON c.user_id = s.user_id
    WHERE s.id = ?
    AND c.kind = 'GN'
    AND c.ts_utc <= COALESCE(s.wake_ts_utc, s.bed_ts_utc)
    ORDER BY c.ts_utc DESC
    LIMIT 1
  `);

  const sessionsForExport = db.prepare(`
    SELECT
      user_id,
      username,
      bed_ts_utc,
      wake_ts_utc,
      sleep_minutes,
      rating_1_10,
      rating_status,
      morning_energy_rating,
      note,
      gm_note
    FROM sessions
    WHERE status = 'CLOSED'
    ORDER BY bed_ts_utc ASC
  `);

  const sessionsForWeeklySummary = db.prepare(`
    SELECT
      user_id,
      username,
      bed_ts_utc,
      wake_ts_utc,
      sleep_minutes,
      rating_1_10,
      note
    FROM sessions
    WHERE status = 'CLOSED'
      AND bed_ts_utc >= ?
      AND bed_ts_utc < ?
    ORDER BY sleep_minutes ASC
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

  const getCheckinById = db.prepare(`
    SELECT * FROM checkins WHERE id = ?
  `);

  const getResetState = db.prepare(`
    SELECT last_reset_checkin_id FROM reset_state WHERE user_id = ?
  `);

  const setResetState = db.prepare(`
    INSERT INTO reset_state (user_id, last_reset_checkin_id)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_reset_checkin_id = excluded.last_reset_checkin_id
  `);

  // ---------------- Pending GN helpers ----------------

  const insertPendingGN = db.prepare(`
    INSERT INTO pending_gn (user_id, checkin_id, bed_ts_utc, raw_content, created_at_utc, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const getPendingGN = db.prepare(`
    SELECT * FROM pending_gn
    WHERE user_id = ?
    ORDER BY created_at_utc DESC
    LIMIT 1
  `);

  const deletePendingGN = db.prepare(`
    DELETE FROM pending_gn WHERE user_id = ? AND checkin_id = ?
  `);

  const getPendingGNsOlderThan = db.prepare(`
    SELECT * FROM pending_gn
    WHERE created_at_utc < ?
  `);

  // ---------------- Wipe all ----------------

  // Track the most recent weekly summary date (MAX over history to avoid duplicates)
  const getLastSummaryDate = db.prepare(`
    SELECT MAX(last_summary_date) AS last_summary_date FROM weekly_summary_state
  `);

  const setLastSummaryDate = db.prepare(`
    INSERT INTO weekly_summary_state (last_summary_date)
    VALUES (?)
    ON CONFLICT(last_summary_date) DO UPDATE SET last_summary_date = excluded.last_summary_date
  `);

  const saveUndoState = db.prepare(`
    INSERT INTO undo_state (user_id, checkin_id, checkin_kind, checkin_ts_utc, checkin_raw_content, checkin_username, session_id, session_data, undo_type, created_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, checkin_id) DO UPDATE SET
      checkin_kind = excluded.checkin_kind,
      checkin_ts_utc = excluded.checkin_ts_utc,
      checkin_raw_content = excluded.checkin_raw_content,
      checkin_username = excluded.checkin_username,
      session_id = excluded.session_id,
      session_data = excluded.session_data,
      undo_type = excluded.undo_type,
      created_at_utc = datetime('now')
  `);

  const getLatestUndoState = db.prepare(`
    SELECT * FROM undo_state 
    WHERE user_id = ?
    ORDER BY created_at_utc DESC, id DESC
    LIMIT 1
  `);

  const getAllUndoStates = db.prepare(`
    SELECT * FROM undo_state 
    WHERE user_id = ?
    ORDER BY created_at_utc DESC, id DESC
  `);

  const deleteUndoState = db.prepare(`
    DELETE FROM undo_state WHERE id = ?
  `);

  const deleteAllUndoStates = db.prepare(`
    DELETE FROM undo_state WHERE user_id = ?
  `);

  const restoreCheckin = db.prepare(`
    INSERT INTO checkins (id, user_id, username, kind, ts_utc, raw_content)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const wipeAllSessions = db.prepare(`DELETE FROM sessions`);
  const wipeAllCheckins = db.prepare(`DELETE FROM checkins`);
  const wipeResetState = db.prepare(`DELETE FROM reset_state`);
  const wipePendingGN = db.prepare(`DELETE FROM pending_gn`);
  const wipeWeeklySummaryState = db.prepare(`DELETE FROM weekly_summary_state`);
  const wipeUndoState = db.prepare(`DELETE FROM undo_state`);

  return {
    // ----- existing API -----
    recordCheckin(userId, username, kind, isoUtc, raw) {
      const info = insertCheckin.run(userId, username, kind, isoUtc, raw);
      return Number(info.lastInsertRowid);
    },

    getOpenSession(userId) {
      return getOpenSession.get(userId) || null;
    },

    getAllOpenSessions(userId) {
      return getAllOpenSessions.all(userId) || [];
    },

    lastSession(userId) {
      return lastSession.get(userId) || null;
    },

    lastSessionNeedingRating(userId) {
      return lastSessionNeedingRating.get(userId) || null;
    },

    lastSessionNeedingMorningRating(userId) {
      return lastSessionNeedingMorningRating.get(userId) || null;
    },

    setMorningRating(sessionId, rating) {
      setMorningRating.run(rating, sessionId);
    },

    createSession(userId, username, bedIsoUtc, note) {
      const info = createSession.run(userId, username, bedIsoUtc, note || null);
      return Number(info.lastInsertRowid);
    },

    closeSession(sessionId, wakeIsoUtc, sleepMinutes, morningRating, gmNote) {
      closeSession.run(wakeIsoUtc, sleepMinutes, morningRating || null, gmNote || null, sessionId);
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

    sessionsForWeeklySummary(startDateIso, endDateIso) {
      return sessionsForWeeklySummary.all(startDateIso, endDateIso);
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

    getCheckinById(checkinId) {
      return getCheckinById.get(checkinId) || null;
    },

    // Undo helpers used by index.js
    reopenSession(sessionId) {
      reopenSession.run(sessionId);
    },

    deleteSession(sessionId) {
      deleteSessionById.run(sessionId);
    },

    updateSessionBedtime(sessionId, bedIsoUtc) {
      updateSessionBedtime.run(bedIsoUtc, sessionId);
    },

    getCheckinsForSession(sessionId) {
      return getCheckinsForSession.all(sessionId) || [];
    },

    clearRating(sessionId) {
      clearRating.run(sessionId);
    },

    // ----- Pending GN API -----

    addPendingGN(userId, checkinId, bedIsoUtc, rawContent, createdAtUtc, note) {
      insertPendingGN.run(userId, checkinId, bedIsoUtc, rawContent, createdAtUtc, note || null);
    },

    getPendingGN(userId) {
      return getPendingGN.get(userId) || null;
    },

    deletePendingGN(userId, checkinId) {
      deletePendingGN.run(userId, checkinId);
    },

    getPendingGNsOlderThan(isoUtc) {
      return getPendingGNsOlderThan.all(isoUtc) || [];
    },

    // ----- Weekly Summary API -----

    getLastSummaryDate() {
      const row = getLastSummaryDate.get();
      return row ? row.last_summary_date : null;
    },

    setLastSummaryDate(dateIso) {
      setLastSummaryDate.run(dateIso);
    },

    // ----- Undo API -----

    saveUndoState(userId, checkinId, checkinKind, checkinTsUtc, checkinRawContent, checkinUsername, sessionId, sessionData, undoType) {
      saveUndoState.run(userId, checkinId, checkinKind, checkinTsUtc, checkinRawContent, checkinUsername, sessionId || null, sessionData || null, undoType);
    },

    getUndoState(userId) {
      return getLatestUndoState.get(userId) || null;
    },

    getAllUndoStates(userId) {
      return getAllUndoStates.all(userId) || [];
    },

    deleteUndoState(undoStateId) {
      deleteUndoState.run(undoStateId);
    },

    deleteAllUndoStates(userId) {
      deleteAllUndoStates.run(userId);
    },

    restoreCheckin(checkinId, userId, username, kind, tsUtc, rawContent) {
      try {
        restoreCheckin.run(checkinId, userId, username, kind, tsUtc, rawContent);
        return true;
      } catch (err) {
        // Checkin might already exist, try without ID
        insertCheckin.run(userId, username, kind, tsUtc, rawContent);
        return false;
      }
    },

    // Keep your old "reset all" for admin
    wipeAll() {
      db.transaction(() => {
        wipeAllSessions.run();
        wipeAllCheckins.run();
        wipeResetState.run();
        wipePendingGN.run();
        wipeWeeklySummaryState.run();
        wipeUndoState.run();
      })();
    },

    close() {
      db.close();
    },
  };
}

module.exports = { initDb };
