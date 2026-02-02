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
      // The session_id might not exist if GN was reset after GM (session was deleted and recreated)
      // So we need to find the most recent OPEN session for this user
      const openSession = db.getOpenSession(undoState.user_id);
      
      if (!openSession) {
        // No open session found - this can happen if GN was reset and not yet undone
        // Try to find the most recent session (might be closed)
        const lastSession = db.lastSession(undoState.user_id);
        if (lastSession && lastSession.status === "OPEN") {
          // Found an open session, use it
          const mins = sessionData.sleep_minutes;
          db.closeSession(
            lastSession.id,
            sessionData.wake_ts_utc,
            mins,
            sessionData.morning_energy_rating || null,
            sessionData.gm_note || null
          );
        } else {
          console.error(`[UNDO] Cannot restore GM: no open session found for user ${undoState.user_id}`);
        }
      } else {
        // Found an open session, close it with the saved data
        const mins = sessionData.sleep_minutes;
        db.closeSession(
          openSession.id,
          sessionData.wake_ts_utc,
          mins,
          sessionData.morning_energy_rating || null,
          sessionData.gm_note || null
        );
      }
    } else if (undoState.undo_type === "RATING_EVENING") {
      // Restore evening rating to the most relevant session (current open or last)
      if (sessionData.rating_1_10 != null) {
        const targetSession = db.getOpenSession(undoState.user_id) || db.lastSession(undoState.user_id);
        if (targetSession) {
          db.setRating(targetSession.id, sessionData.rating_1_10);
        }
      }
    } else if (undoState.undo_type === "RATING_MORNING") {
      // Restore morning rating to the most recent CLOSED session
      if (sessionData.morning_energy_rating != null) {
        const lastSession = db.lastSession(undoState.user_id);
        if (lastSession && lastSession.status === "CLOSED") {
          db.setMorningRating(lastSession.id, sessionData.morning_energy_rating);
        }
      }
    }
  }

  // Remove this undo state from the stack (but keep others for multiple undos)
  db.deleteUndoState(undoState.id);

  // Check if there are more undos available
  const remainingUndos = db.getAllUndoStates(message.author.id);
  const hasMore = remainingUndos.length > 0;

  const undoMessage = `✅ Re-added: \`${undoState.checkin_raw_content || "unknown"}\`${hasMore ? " (more undos available)" : ""}`;
  console.log(`[UNDO] User ${message.author.id} undid: ${undoState.checkin_raw_content}`);
  await safeReply(message, undoMessage);
  await message.react("✅").catch(() => {});
}

module.exports = { handleUndo };
