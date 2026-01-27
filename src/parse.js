// src/parse.js
const { DateTime } = require("luxon");

const GOODNIGHT = new Set(["gn", "goodnight", "good night", "gngn", "night", "good nite"]);
const GOODMORNING = new Set(["gm", "goodmorning", "good morning", "morning"]);

function normalize(s) {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

// Accepts: 9pm, 9 PM, 9:00am, 9:00 am, 21:15, 09:30, 9, 9:00
function parseTimeToken(token) {
  if (!token) return null;
  const t = token.trim();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;

  const rawHour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = m[3] ? m[3].toLowerCase() : null;

  if (minute < 0 || minute > 59) return null;
  if (rawHour < 0 || rawHour > 23) return null;
  if (suffix && (rawHour < 1 || rawHour > 12)) return null;

  return { rawHour, minute, suffix }; // suffix: 'am'|'pm'|null
}

// If suffix provided -> 1 interpretation.
// If suffix missing and rawHour<=12 -> ambiguous -> both AM and PM.
// If rawHour>12 -> 24h -> 1 interpretation.
function expandInterpretations(parsed) {
  if (!parsed) return [];
  const { rawHour, minute, suffix } = parsed;

  if (suffix === "am") {
    const hour = rawHour === 12 ? 0 : rawHour;
    return [{ hour, minute }];
  }
  if (suffix === "pm") {
    const hour = rawHour === 12 ? 12 : rawHour + 12;
    return [{ hour, minute }];
  }

  if (rawHour > 12) return [{ hour: rawHour, minute }];

  const amHour = rawHour === 12 ? 0 : rawHour;
  const pmHour = rawHour === 12 ? 12 : rawHour + 12;
  return [{ hour: amHour, minute }, { hour: pmHour, minute }];
}

// GN override: choose a sensible interpretation around "now".
// Allows proactive logging like 10pm + (11pm) => today 11pm.
// If candidate is >12h in future, shift to previous day.
function computeBedtimeUtcFromOverride(timeToken, defaultTz) {
  const now = DateTime.now().setZone(defaultTz);
  const parsed = parseTimeToken(timeToken);
  const opts = expandInterpretations(parsed);
  if (opts.length === 0) return null;

  const candidates = [];
  for (const { hour, minute } of opts) {
    const today = now.set({ hour, minute, second: 0, millisecond: 0 });
    candidates.push(today, today.minus({ days: 1 }));
  }

  // pick candidate closest to now
  let best = candidates[0];
  let bestScore = Math.abs(best.diff(now, "minutes").minutes);
  for (const c of candidates.slice(1)) {
    const score = Math.abs(c.diff(now, "minutes").minutes);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }

  if (best > now && best.diff(now, "hours").hours > 12) best = best.minus({ days: 1 });
  return best.toUTC().toISO();
}

// GM override: always interpret as next occurrence after bed.
// If ambiguous (no am/pm), pick the one that yields the smallest positive delta after bed.
function computeWakeUtcFromOverride(timeToken, bedIsoUtc, defaultTz) {
  const bedLocal = DateTime.fromISO(bedIsoUtc, { zone: "utc" }).setZone(defaultTz);

  const parsed = parseTimeToken(timeToken);
  const opts = expandInterpretations(parsed);
  if (opts.length === 0) return null;

  let best = null;
  let bestDelta = Infinity;

  for (const { hour, minute } of opts) {
    let wake = bedLocal.set({ hour, minute, second: 0, millisecond: 0 });
    if (wake <= bedLocal) wake = wake.plus({ days: 1 });

    const delta = wake.diff(bedLocal, "minutes").minutes;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = wake;
    }
  }

  return best.toUTC().toISO();
}

function minutesBetween(isoUtcA, isoUtcB) {
  const a = DateTime.fromISO(isoUtcA, { zone: "utc" });
  const b = DateTime.fromISO(isoUtcB, { zone: "utc" });
  return Math.round(b.diff(a, "minutes").minutes);
}

// Parse:
// - rating only: "!5"
// - commands: "gn (11pm) !8", "gn !5", "gm (9am)", "good morning (9:00 am)"
// - with notes: "gn !5 (9pm) \"pset grinding\"", "gn \"pset grinding\" !5 (9pm)"
function parseMessage(raw) {
  const trimmed = raw.trim();
  // Normalize smart quotes to standard quotes so mobile input like “note” works
  const normalized = trimmed.replace(/[“”]/g, '"');

  const ratingOnly = normalized.match(/^!\s*([1-9]|10)\s*$/);
  if (ratingOnly) return { kind: "RATING_ONLY", rating: Number(ratingOnly[1]) };

  // Extract quoted note first (can be anywhere after the command)
  let note = null;
  let withoutNote = normalized;
  const noteMatch = normalized.match(/"([^"]*)"/);
  if (noteMatch) {
    note = noteMatch[1].trim();
    // Remove the quoted text from the string
    withoutNote = normalized.slice(0, noteMatch.index) + normalized.slice(noteMatch.index + noteMatch[0].length);
    withoutNote = withoutNote.trim();
  }

  let rating = null;
  const ratingMatch = withoutNote.match(/!\s*([1-9]|10)\s*$/);
  let withoutRating = withoutNote;
  if (ratingMatch) {
    rating = Number(ratingMatch[1]);
    withoutRating = withoutNote.slice(0, ratingMatch.index).trim();
  }

  let timeToken = null;
  const timeMatch = withoutRating.match(/\(\s*([^)]+)\s*\)\s*$/);
  let commandPart = withoutRating;
  if (timeMatch) {
    timeToken = timeMatch[1].trim();
    commandPart = withoutRating.slice(0, timeMatch.index).trim();
  }

  const cmd = normalize(commandPart);
  if (GOODNIGHT.has(cmd)) return { kind: "GN", timeToken, rating, note };
  if (GOODMORNING.has(cmd)) return { kind: "GM", timeToken, rating, note };
  return { kind: "UNKNOWN" };
}

module.exports = {
  computeBedtimeUtcFromOverride,
  computeWakeUtcFromOverride,
  minutesBetween,
  parseMessage,
};
