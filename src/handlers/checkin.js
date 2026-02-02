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
  promptMorningEnergy,
  remindMorningEnergy,
  promptBothRatingsAfterGM,
  promptMorningAfterEvening,
} = require("../utils");

// Helper to calculate hours since a session was created
function hoursSinceSession(sessionBedIsoUtc) {
  const bedTime = new Date(sessionBedIsoUtc);
  const now = new Date();
  return (now - bedTime) / (1000 * 60 * 60); // Convert ms to hours
}

async function handleRatingOnly(message, parsed, userId, username, raw, db) {
  // Look at both missing ratings to decide where this rating should go
  const needsEvening = db.lastSessionNeedingRating(userId);
  const needsMorning = db.lastSessionNeedingMorningRating(userId);

  const nowIsoUtc = new Date().toISOString();

  // If the same session is missing BOTH evening and morning ratings,
  // treat the *first* standalone rating as the evening rating.
  if (needsEvening && needsMorning && needsEvening.id === needsMorning.id) {
    db.setRating(needsEvening.id, parsed.rating);
    db.recordCheckin(userId, username, "RATING", nowIsoUtc, raw);
    db.deleteAllUndoStates(userId);
    await message.react("✅").catch(() => {});

     // Now prompt explicitly for the morning rating
     const stillNeedsMorning = db.lastSessionNeedingMorningRating(userId);
     if (stillNeedsMorning && stillNeedsMorning.id === needsEvening.id) {
       await promptMorningAfterEvening(message);
     }

    return;
  }

  // Otherwise: prefer filling a missing morning rating first
  if (needsMorning) {
    db.setMorningRating(needsMorning.id, parsed.rating);
    db.recordCheckin(userId, username, "RATING", nowIsoUtc, raw);
    db.deleteAllUndoStates(userId);
    await message.react("✅").catch(() => {});
    return;
  }

  // Finally, fall back to evening rating if needed
  if (needsEvening) {
    db.setRating(needsEvening.id, parsed.rating);
    db.recordCheckin(userId, username, "RATING", nowIsoUtc, raw);
    db.deleteAllUndoStates(userId);
    await message.react("✅").catch(() => {});
    return;
  }

  // No session needs any rating
  await message.react("❓").catch(() => {});
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
    db.addPendingGN(userId, checkinId, bedIsoUtc, raw, nowIsoUtc, parsed.note);
    
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
    const sessionId = db.createSession(userId, username, pending.bed_ts_utc, pending.note);
    
    if (parsed.rating != null) {
      db.setRating(sessionId, parsed.rating);
    } else {
      await promptRating(message);
    }
    
    await message.react("🌙").catch(() => {});
    return;
  }

  // No open session - create session normally
  const sessionId = db.createSession(userId, username, bedIsoUtc, parsed.note);
  db.recordCheckin(userId, username, "GN", bedIsoUtc, raw);
  // Clear undo stack when new checkin is made
  db.deleteAllUndoStates(userId);

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

  // Check for negative sleep duration - this happens when bedtime was misinterpreted
  // (e.g., "11:45" was interpreted as 11:45 AM instead of 11:45 PM the previous night)
  let bedIsoUtc = targetSession.bed_ts_utc;
  let mins = minutesBetween(bedIsoUtc, wakeIsoUtc);
  
  if (mins < 0) {
    // Negative sleep - try to fix by checking if the original GN had an ambiguous time
    // We need to check the original checkin to see if it had a time override
    const checkins = db.getCheckinsForSession(targetSession.id);
    const gnCheckin = checkins.length > 0 ? checkins[0] : null;
    
    if (gnCheckin && gnCheckin.raw_content) {
      // Parse the original GN command to see if it had a time token
      const { parseMessage } = require("../parse");
      const originalParsed = parseMessage(gnCheckin.raw_content);
      
      if (originalParsed.timeToken) {
        // Check if the time was ambiguous (no AM/PM specified)
        const { parseTimeToken } = require("../parse");
        const timeParsed = parseTimeToken(originalParsed.timeToken);
        
        if (timeParsed && !timeParsed.suffix && timeParsed.rawHour <= 12) {
          // Ambiguous time without AM/PM - try PM interpretation from previous night
          const { DateTime } = require("luxon");
          const wakeLocal = DateTime.fromISO(wakeIsoUtc, { zone: "utc" }).setZone(defaultTz);
          const bedLocalCurrent = DateTime.fromISO(bedIsoUtc, { zone: "utc" }).setZone(defaultTz);
          
          // If the current bedtime interpretation is after the wake time, try PM from previous day
          if (bedLocalCurrent >= wakeLocal) {
            // Try PM interpretation from the day before wake time
            const bedLocal = wakeLocal.minus({ days: 1 }).set({ 
              hour: timeParsed.rawHour === 12 ? 12 : timeParsed.rawHour + 12, 
              minute: timeParsed.minute, 
              second: 0, 
              millisecond: 0 
            });
            
            // Only use this if it makes sense (bedtime before wake time and reasonable sleep duration)
            const newBedIsoUtc = bedLocal.toUTC().toISO();
            const newMins = minutesBetween(newBedIsoUtc, wakeIsoUtc);
            
            if (newMins > 0 && newMins <= 16 * 60) { // Max 16 hours sleep
              bedIsoUtc = newBedIsoUtc;
              mins = newMins;
              
              // Update the session's bedtime
              db.updateSessionBedtime(targetSession.id, bedIsoUtc);
            }
          }
        }
      }
    }
  }
  
  db.closeSession(targetSession.id, wakeIsoUtc, mins, parsed.rating || null, parsed.note || null);
  db.recordCheckin(userId, username, "GM", wakeIsoUtc, raw);
  // Clear undo stack when new checkin is made
  db.deleteAllUndoStates(userId);

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

  // Priority: session consistency first, then energy ratings
  // Check which ratings are missing for this specific session
  const needsEvening = db.lastSessionNeedingRating(userId);
  const needsMorning = db.lastSessionNeedingMorningRating(userId);

  const thisNeedsEvening = needsEvening && needsEvening.id === targetSession.id;
  const thisNeedsMorning = needsMorning && needsMorning.id === targetSession.id;

  if (thisNeedsEvening && thisNeedsMorning) {
    // Both missing: be explicit about the two-step process
    await promptBothRatingsAfterGM(message);
  } else if (thisNeedsEvening) {
    // Only evening missing
    await remindRatingOnGM(message);
  } else if (thisNeedsMorning && parsed.rating == null) {
    // Only morning missing and none was provided inline
    await promptMorningEnergy(message);
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
    const sessionId = db.createSession(pending.user_id, checkin.username, pending.bed_ts_utc, pending.note);
    
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
