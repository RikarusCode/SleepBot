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
  if (open) {
    // consecutive GN (GN->GN) implies missing GM
    await promptMissingGM(message);
  }

  const nowIsoUtc = new Date().toISOString();
  const bedIsoUtc = parsed.timeToken ? computeBedtimeUtcFromOverride(parsed.timeToken, defaultTz) : nowIsoUtc;
  if (parsed.timeToken && !bedIsoUtc) {
    await safeReply(message, "I couldn't parse that time. Try `(11pm)`, `(9:00 am)`, or `(21:15)`.");
    return;
  }

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
  const open = db.getOpenSession(userId);

  if (!open) {
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
  const wakeIsoUtc = parsed.timeToken ? computeWakeUtcFromOverride(parsed.timeToken, open.bed_ts_utc, defaultTz) : nowIsoUtc;
  if (parsed.timeToken && !wakeIsoUtc) {
    await safeReply(message, "I couldn't parse that time. Try `(9am)`, `(9:00 am)`, or `(21:15)`.");
    return;
  }

  const mins = minutesBetween(open.bed_ts_utc, wakeIsoUtc);
  db.closeSession(open.id, wakeIsoUtc, mins);
  db.recordCheckin(userId, username, "GM", wakeIsoUtc, raw);

  // If rating still missing for this session, remind on GM (per your rules)
  const needsRating = db.lastSessionNeedingRating(userId);
  if (needsRating && needsRating.id === open.id) {
    await remindRatingOnGM(message);
  }

  await message.react("☀️").catch(() => {});
}

module.exports = {
  handleRatingOnly,
  handleGN,
  handleGM,
};
