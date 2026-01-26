// src/commands/undo.js
const { safeReply } = require("../utils");

async function handleUndo(message, db) {
  const undoState = db.getUndoState(message.author.id);
  
  if (!undoState) {
    await safeReply(message, "No reset operation to undo.");
    return;
  }

  // Restore the checkin
  const restored = db.restoreCheckin(
    undoState.checkin_id,
    undoState.user_id,
    undoState.checkin_username,
    undoState.checkin_kind,
    undoState.checkin_ts_utc,
    undoState.checkin_raw_content
  );

  // Restore session state based on undo type
  if (undoState.session_id && undoState.session_data) {
    const sessionData = JSON.parse(undoState.session_data);
    
    if (undoState.undo_type === "GN") {
      // Restore the deleted session
      const sessionId = db.createSession(
        sessionData.user_id,
        sessionData.username,
        sessionData.bed_ts_utc,
        sessionData.note
      );
      
      if (sessionData.rating_1_10 != null) {
        db.setRating(sessionId, sessionData.rating_1_10);
      } else if (sessionData.rating_status === "OMITTED") {
        db.omitRating(sessionId);
      }
    } else if (undoState.undo_type === "GM") {
      // Restore the closed session state
      const mins = sessionData.sleep_minutes;
      db.closeSession(
        undoState.session_id,
        sessionData.wake_ts_utc,
        mins,
        sessionData.morning_energy_rating || null,
        sessionData.gm_note || null
      );
    } else if (undoState.undo_type === "RATING_EVENING") {
      // Restore evening rating
      if (sessionData.rating_1_10 != null) {
        db.setRating(undoState.session_id, sessionData.rating_1_10);
      }
    } else if (undoState.undo_type === "RATING_MORNING") {
      // Restore morning rating
      if (sessionData.morning_energy_rating != null) {
        db.setMorningRating(undoState.session_id, sessionData.morning_energy_rating);
      }
    }
  }

  // Clear undo state
  db.deleteUndoState(message.author.id);

  await safeReply(message, `✅ Re-added: \`${undoState.checkin_raw_content}\``);
  await message.react("✅").catch(() => {});
}

module.exports = { handleUndo };
