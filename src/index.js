// src/index.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const { initDb } = require("./db");

const TOKEN = process.env.DISCORD_TOKEN;
const SLEEP_CHANNEL_ID = process.env.SLEEP_CHANNEL_ID;
const DB_PATH = process.env.DB_PATH || "./sleep.sqlite";
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Los_Angeles";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || null;

if (!TOKEN) throw new Error("DISCORD_TOKEN missing from .env");
if (!SLEEP_CHANNEL_ID) throw new Error("SLEEP_CHANNEL_ID missing from .env");

const db = initDb(DB_PATH);

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
function computeBedtimeUtcFromOverride(timeToken) {
  const now = DateTime.now().setZone(DEFAULT_TZ);
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
function computeWakeUtcFromOverride(timeToken, bedIsoUtc) {
  const bedLocal = DateTime.fromISO(bedIsoUtc, { zone: "utc" }).setZone(DEFAULT_TZ);

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
function parseMessage(raw) {
  const trimmed = raw.trim();

  const ratingOnly = trimmed.match(/^!\s*([1-9]|10)\s*$/);
  if (ratingOnly) return { kind: "RATING_ONLY", rating: Number(ratingOnly[1]) };

  let rating = null;
  const ratingMatch = trimmed.match(/!\s*([1-9]|10)\s*$/);
  let withoutRating = trimmed;
  if (ratingMatch) {
    rating = Number(ratingMatch[1]);
    withoutRating = trimmed.slice(0, ratingMatch.index).trim();
  }

  let timeToken = null;
  const timeMatch = withoutRating.match(/\(\s*([^)]+)\s*\)\s*$/);
  let commandPart = withoutRating;
  if (timeMatch) {
    timeToken = timeMatch[1].trim();
    commandPart = withoutRating.slice(0, timeMatch.index).trim();
  }

  const cmd = normalize(commandPart);
  if (GOODNIGHT.has(cmd)) return { kind: "GN", timeToken, rating };
  if (GOODMORNING.has(cmd)) return { kind: "GM", timeToken, rating };
  return { kind: "UNKNOWN" };
}

async function safeReply(message, text) {
  try {
    await message.reply(text);
  } catch {
    // If Send Messages is missing, replies will fail—no crash.
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Watching channel ${SLEEP_CHANNEL_ID} tz=${DEFAULT_TZ}`);
  console.log(`DB: ${DB_PATH}`);
});

async function promptRating(message) {
  await safeReply(message, "Quick check-in: reply with `!1`–`!10` for how energetic you felt today (10 = great).");
}

async function promptMissingGM(message) {
  await safeReply(
    message,
    "I saw two `gn` in a row. If you forgot a good morning, you can log it retroactively like: `gm (9am)`"
  );
}

async function promptConsecutiveGM(message) {
  await safeReply(
    message,
    "I saw two `gm` in a row. If you meant to correct the time, use `gm (9am)`; otherwise ignore."
  );
}

async function remindRatingOnGM(message) {
  await safeReply(message, "Reminder: you still owe an energy rating. Reply with `!1`–`!10`.");
}

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== SLEEP_CHANNEL_ID) return;

    const userId = message.author.id;
    const username = message.author.username;
    const raw = message.content;

    // Export command (admin-only optional)
    // ---- DM Export: !export ----
    if (raw.trim() === "!export") {
      const rows = db.sessionsForExport();
    
      if (rows.length === 0) {
        await safeReply(message, "No completed sessions to export yet.");
        return;
      }
    
      const header = ["user_id","username","bed_ts_utc","wake_ts_utc","sleep_minutes","rating_1_10","rating_status"];
      const lines = [header.join(",")];
    
      for (const r of rows) {
        const vals = header.map((k) => (r[k] == null ? "" : String(r[k]).replaceAll('"', '""')));
        lines.push(vals.map(v => `"${v}"`).join(","));
      }
    
      const csv = lines.join("\n");
    
      try {
        const file = new AttachmentBuilder(Buffer.from(csv, "utf8"), { name: "sleep_sessions.csv" });
        await message.author.send({
          content: `Here’s the full export (${rows.length} sessions).`,
          files: [file],
        });
    
        await safeReply(message, "📩 I DMed you the full CSV export.");
        await message.react("📩").catch(() => {});
      } catch {
        await safeReply(
          message,
          "I couldn't DM you the file. Enable DMs for this server (or allow DMs from server members), then try again."
        );
      }
    
      return;
    }
    
    
    // ---- Reset commands ----
    // Anyone: !reset last
    // Admin-only: !reset all
    if (raw.trim().startsWith("!reset")) {
      const parts = raw.trim().split(/\s+/);
      const arg = (parts[1] || "").toLowerCase();

      if (arg === "all") {
        if (!ADMIN_USER_ID || message.author.id !== ADMIN_USER_ID) {
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
            "I already reset your most recent entry. I won’t roll back further."
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
      return;
    }

    const parsed = parseMessage(raw);
    if (parsed.kind === "UNKNOWN") return;

    const nowIsoUtc = new Date().toISOString();

    // Rating-only message: "!5"
    if (parsed.kind === "RATING_ONLY") {
      const target = db.lastSessionNeedingRating(userId);
      if (!target) {
        await message.react("❓").catch(() => {});
        return;
      }
      db.setRating(target.id, parsed.rating);
      db.recordCheckin(userId, username, "RATING", nowIsoUtc, raw);
      await message.react("✅").catch(() => {});
      return;
    }

    // GN
    if (parsed.kind === "GN") {
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

      const bedIsoUtc = parsed.timeToken ? computeBedtimeUtcFromOverride(parsed.timeToken) : nowIsoUtc;
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
      return;
    }

    // GM
    if (parsed.kind === "GM") {
      const open = db.getOpenSession(userId);

      if (!open) {
        // Could be consecutive GM or a GM without a GN
        const last = db.lastSession(userId);
        if (last && last.status === "CLOSED") {
          await promptConsecutiveGM(message);
        } else {
          await safeReply(message, "I don’t see an open session (no prior `gn`). Send `gn` first.");
        }
        return;
      }

      const wakeIsoUtc = parsed.timeToken ? computeWakeUtcFromOverride(parsed.timeToken, open.bed_ts_utc) : nowIsoUtc;
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
      return;
    }
  } catch (err) {
    console.error("Error:", err);
  }
});

// Clean shutdown
process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

client.login(TOKEN);
