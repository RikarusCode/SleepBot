// src/handlers/checkin.js
const {
  computeBedtimeUtcFromOverride,
  computeWakeUtcFromOverride,
  minutesBetween,
} = require("../parse");
const {
  safeReply,
  promptRating,
  promptMissingGM,
  promptConsecutiveGM,
  remindRatingOnGM,
} = require("../utils");

// Helper to calculate hours since a session was created
function hoursSinceSession(sessionBedIsoUtc) {
  const bedTime = new Date(sessionBedIsoUtc);
  const now = new Date();
  return (now - bedTime) / (1000 * 60 * 60); // Convert ms to hours
}

async function handleRatingOnly(message, parsed, userId, username, raw, db) {
  const target = db.lastSessionNeedingRating(userId);
  if (!target) {
    await message.react("❓").catch(() => {});
    return;
  }
  const nowIsoUtc = new Date().toISOString();
  db.setRating(target.id, parsed.rating);
  db.recordCheckin(userId, username, "RATING", nowIsoUtc, raw);
  await message.react("✅").catch(() => {});
}

async function handleGN(message, parsed, userId, username, raw, db, defaultTz) {
  // If previous session is missing rating and it's CLOSED, and user starts next GN, omit it
  const missingRating = db.lastSessionNeedingRating(userId);
  if (missingRating && missingRating.status === "CLOSED") {
    db.omitRating(missingRating.id);
  }

  const open = db.getOpenSession(userId);
  const nowIsoUtc = new Date().toISOString();
  const bedIsoUtc = parsed.timeToken ? computeBedtimeUtcFromOverride(parsed.timeToken, defaultTz) : nowIsoUtc;
  
  if (parsed.timeToken && !bedIsoUtc) {
    await safeReply(message, "I couldn't parse that time. Try `(11pm)`, `(9:00 am)`, or `(21:15)`.");
    return;
  }

  if (open) {
    // There's an open session - record the GN checkin but DON'T create a session
    // Store it as pending so it can be converted to a session after 1 hour
    
    // If there's already a pending GN, delete it (replace with new one)
    const existingPending = db.getPendingGN(userId);
    if (existingPending) {
      db.deletePendingGN(userId, existingPending.checkin_id);
    }
    
    const checkinId = db.recordCheckin(userId, username, "GN", bedIsoUtc, raw);
    db.addPendingGN(userId, checkinId, bedIsoUtc, raw, nowIsoUtc);
    
    // Don't react with emoji - "secretly" record it
    // Prompt user to fix the previous session
    await promptMissingGM(message);
    return;
  }
  
  // Check if there's a pending GN that should be converted to a session
  // (This handles the case where the old session was deleted but pending GN exists)
  const pending = db.getPendingGN(userId);
  if (pending) {
    // Delete the pending GN and create session from it
    db.deletePendingGN(userId, pending.checkin_id);
    const sessionId = db.createSession(userId, username, pending.bed_ts_utc);
    
    if (parsed.rating != null) {
      db.setRating(sessionId, parsed.rating);
    } else {
      await promptRating(message);
    }
    
    await message.react("🌙").catch(() => {});
    return;
  }

  // No open session - create session normally
  const sessionId = db.createSession(userId, username, bedIsoUtc);
  db.recordCheckin(userId, username, "GN", bedIsoUtc, raw);

  if (parsed.rating != null) {
    db.setRating(sessionId, parsed.rating);
  } else {
    await promptRating(message);
  }

  await message.react("🌙").catch(() => {});
}

async function handleGM(message, parsed, userId, username, raw, db, defaultTz) {
  const allOpen = db.getAllOpenSessions(userId);

  if (allOpen.length === 0) {
    // Could be consecutive GM or a GM without a GN
    const last = db.lastSession(userId);
    if (last && last.status === "CLOSED") {
      await promptConsecutiveGM(message);
    } else {
      await safeReply(message, "I don't see an open session (no prior `gn`). Send `gn` first.");
    }
    return;
  }

  const nowIsoUtc = new Date().toISOString();
  let targetSession = allOpen[0]; // Default to most recent

  // If there are multiple open sessions and GM has a time override, try to find the best match
  if (allOpen.length > 1 && parsed.timeToken) {
    const wakeIsoUtc = computeWakeUtcFromOverride(parsed.timeToken, allOpen[0].bed_ts_utc, defaultTz);
    if (wakeIsoUtc) {
      const wakeTime = new Date(wakeIsoUtc);
      const now = new Date();
      
      // If wake time is in the past (retroactive), find the session whose bedtime is closest
      if (wakeTime < now) {
        let bestMatch = allOpen[0];
        let bestScore = Infinity;
        
        for (const session of allOpen) {
          const bedTime = new Date(session.bed_ts_utc);
          const sleepDuration = (wakeTime - bedTime) / (1000 * 60 * 60); // hours
          
          // Prefer sessions with reasonable sleep duration (4-12 hours)
          // and where wake time is after bedtime
          if (wakeTime > bedTime && sleepDuration >= 4 && sleepDuration <= 12) {
            const score = Math.abs(sleepDuration - 8); // Prefer ~8 hours
            if (score < bestScore) {
              bestScore = score;
              bestMatch = session;
            }
          }
        }
        
        // If we found a reasonable match, use it; otherwise use most recent
        if (bestScore < Infinity) {
          targetSession = bestMatch;
        }
      }
    }
  }

  const wakeIsoUtc = parsed.timeToken ? computeWakeUtcFromOverride(parsed.timeToken, targetSession.bed_ts_utc, defaultTz) : nowIsoUtc;
  if (parsed.timeToken && !wakeIsoUtc) {
    await safeReply(message, "I couldn't parse that time. Try `(9am)`, `(9:00 am)`, or `(21:15)`.");
    return;
  }

  const mins = minutesBetween(targetSession.bed_ts_utc, wakeIsoUtc);
  db.closeSession(targetSession.id, wakeIsoUtc, mins);
  db.recordCheckin(userId, username, "GM", wakeIsoUtc, raw);

  // Delete any other open sessions that are older than the one we just completed
  for (const session of allOpen) {
    if (session.id !== targetSession.id) {
      db.deleteSession(session.id);
    }
  }

  // Clear pending GN since the user has now completed the previous session
  // They can now do a new gn if they want
  const pending = db.getPendingGN(userId);
  if (pending) {
    db.deletePendingGN(userId, pending.checkin_id);
  }

  // Priority: session consistency first, then energy rating
  // If rating still missing for this session, remind on GM (per your rules)
  const needsRating = db.lastSessionNeedingRating(userId);
  if (needsRating && needsRating.id === targetSession.id) {
    await remindRatingOnGM(message);
  }

  await message.react("☀️").catch(() => {});
}

// Check and convert pending GNs that are 1+ hours old
function processPendingGNs(db, defaultTz) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneHourAgoIso = oneHourAgo.toISOString();
  
  const pendingGNs = db.getPendingGNsOlderThan(oneHourAgoIso);
  
  for (const pending of pendingGNs) {
    // Get the checkin to retrieve username
    const checkin = db.getCheckinById(pending.checkin_id);
    if (!checkin) {
      // Checkin was deleted, clean up pending record
      db.deletePendingGN(pending.user_id, pending.checkin_id);
      continue;
    }
    
    // Delete the old open session if it exists
    const open = db.getOpenSession(pending.user_id);
    if (open) {
      db.deleteSession(open.id);
    }
    
    // Create session from the pending GN
    const sessionId = db.createSession(pending.user_id, checkin.username, pending.bed_ts_utc);
    
    // Delete the pending GN record
    db.deletePendingGN(pending.user_id, pending.checkin_id);
  }
}

module.exports = {
  handleRatingOnly,
  handleGN,
  handleGM,
  processPendingGNs,
};
