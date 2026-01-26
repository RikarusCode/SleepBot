// src/commands/reset.js
const { safeReply } = require("../utils");

async function handleReset(message, raw, db, adminUserId) {
  const parts = raw.trim().split(/\s+/);
  const arg = (parts[1] || "").toLowerCase();

  if (arg === "all") {
    if (!adminUserId || message.author.id !== adminUserId) {
      await safeReply(message, "Not allowed.");
      return;
    }
    db.wipeAll();
    await safeReply(message, "♻️ Reset complete: wiped ALL data.");
    await message.react("♻️").catch(() => {});
    return;
  }

  if (arg === "last") {
    const last = db.lastCheckin(message.author.id);
    if (!last) {
      await safeReply(message, "No data to reset yet.");
      return;
    }
  
    // Allow multiple resets - each one adds to the undo stack
    // No longer blocking multiple resets in a row
  
    // Save undo state before making changes
    let sessionData = null;
    let sessionId = null;
    let undoType = null;
  
    // Undo logic depends on what the last checkin was
    if (last.kind === "GM") {
      // Undo wake-up: reopen the session
      const open = db.getOpenSession(message.author.id);
      // If there is no open session, find the last CLOSED one
      const session = open || db.lastSession(message.author.id);
      if (session && session.status === "CLOSED") {
        sessionId = session.id;
        sessionData = JSON.stringify({
          wake_ts_utc: session.wake_ts_utc,
          sleep_minutes: session.sleep_minutes,
          morning_energy_rating: session.morning_energy_rating,
          gm_note: session.gm_note,
        });
        undoType = "GM";
        db.reopenSession(session.id);
      }
    }
  
    if (last.kind === "GN") {
      // Undo bedtime: delete the OPEN session
      const open = db.getOpenSession(message.author.id);
      if (open) {
        sessionId = open.id;
        sessionData = JSON.stringify({
          user_id: open.user_id,
          username: open.username,
          bed_ts_utc: open.bed_ts_utc,
          rating_1_10: open.rating_1_10,
          rating_status: open.rating_status,
          note: open.note,
        });
        undoType = "GN";
        db.deleteSession(open.id);
      }
    }
  
    if (last.kind === "RATING") {
      // Undo rating: clear rating on last session
      const session = db.lastSession(message.author.id);
      if (session) {
        sessionId = session.id;
        // Determine if it's evening or morning rating
        // Check if session needs morning rating (closed but no morning rating)
        // If it does, the rating we're resetting was likely a morning rating
        const needsMorningRating = session.status === "CLOSED" && session.morning_energy_rating == null;
        
        // Also check if morning_energy_rating exists - if it does, this was likely a morning rating
        // But we need to check BEFORE we clear anything
        if (session.morning_energy_rating != null) {
          // This was a morning rating
          sessionData = JSON.stringify({
            morning_energy_rating: session.morning_energy_rating,
            type: "morning_rating",
          });
          undoType = "RATING_MORNING";
          // Clear morning rating
          db.setMorningRating(session.id, null);
        } else if (session.rating_1_10 != null) {
          // This was an evening rating
          sessionData = JSON.stringify({
            rating_1_10: session.rating_1_10,
            rating_status: session.rating_status,
            type: "evening_rating",
          });
          undoType = "RATING_EVENING";
          db.clearRating(session.id);
        } else {
          // No rating to clear, but we still need to handle the checkin deletion
          sessionData = JSON.stringify({ type: "unknown" });
          undoType = "RATING_UNKNOWN";
        }
      }
    }
  
    // Save undo state (even if sessionId/sessionData is null)
    db.saveUndoState(
      message.author.id,
      last.id,
      last.kind,
      last.ts_utc,
      last.raw_content || "",
      last.username || message.author.username,
      sessionId,
      sessionData,
      undoType || last.kind
    );
  
    db.deleteCheckin(last.id);
    db.setLastResetCheckinId(message.author.id, last.id);
  
    const resetMessage = `♻️ Reset your last entry: \`${last.raw_content || "unknown"}\``;
    console.log(`[RESET] User ${message.author.id} reset: ${last.raw_content}`);
    await safeReply(message, resetMessage);
    await message.react("♻️").catch(() => {});
    return;
  }

  await safeReply(message, "Usage: `!reset last` (anyone) or `!reset all` (admin only).");
}

module.exports = { handleReset };
