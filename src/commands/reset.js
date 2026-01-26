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
  
    const alreadyReset = db.getLastResetCheckinId(message.author.id);
    if (alreadyReset && Number(alreadyReset) === Number(last.id)) {
      await safeReply(
        message,
        "I already reset your most recent entry. I won't roll back further."
      );
      return;
    }
  
    // Undo logic depends on what the last checkin was
    if (last.kind === "GM") {
      // Undo wake-up: reopen the session
      const open = db.getOpenSession(message.author.id);
      // If there is no open session, find the last CLOSED one
      const session = open || db.lastSession(message.author.id);
      if (session && session.status === "CLOSED") {
        db.reopenSession(session.id);
      }
    }
  
    if (last.kind === "GN") {
      // Undo bedtime: delete the OPEN session
      const open = db.getOpenSession(message.author.id);
      if (open) {
        db.deleteSession(open.id);
      }
    }
  
    if (last.kind === "RATING") {
      // Undo rating: clear rating on last session
      const session = db.lastSession(message.author.id);
      if (session) {
        db.clearRating(session.id);
      }
    }
  
    db.deleteCheckin(last.id);
    db.setLastResetCheckinId(message.author.id, last.id);
  
    await safeReply(message, "♻️ Reset your last entry.");
    await message.react("♻️").catch(() => {});
    return;
  }

  await safeReply(message, "Usage: `!reset last` (anyone) or `!reset all` (admin only).");
}

module.exports = { handleReset };
