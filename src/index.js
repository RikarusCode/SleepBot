require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const { Client, GatewayIntentBits } = require("discord.js");
const { initDb } = require("./db");

const TOKEN = process.env.DISCORD_TOKEN;
const SLEEP_CHANNEL_ID = process.env.SLEEP_CHANNEL_ID;
const DB_PATH = process.env.DB_PATH || "./sleep.sqlite";
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Los_Angeles";

// Optional: restrict exports to a single Discord user ID (you)
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || null;

if (!TOKEN) throw new Error("DISCORD_TOKEN missing from .env");
if (!SLEEP_CHANNEL_ID) throw new Error("SLEEP_CHANNEL_ID missing from .env");

const db = initDb(DB_PATH);

const GOODNIGHT = new Set(["gn", "goodnight", "good night", "gngn", "night", "good nite"]);
const GOODMORNING = new Set(["gm", "goodmorning", "good morning", "morning"]);

// ---------- Parsing helpers ----------

function normalize(s) {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

// Extract optional "(time)" and optional "!rating".
// Examples:
// "gn (11pm) !8"
// "gm (9am)"
// "gn !5"
// "!7"
function parseMessage(raw) {
  const trimmed = raw.trim();

  // rating-only message: "!5"
  const ratingOnly = trimmed.match(/^!\s*([1-9]|10)\s*$/);
  if (ratingOnly) {
    return { kind: "RATING_ONLY", rating: Number(ratingOnly[1]) };
  }

  // pull rating token anywhere (expect user puts it after GN/GM, but allow flexible)
  let rating = null;
  const ratingMatch = trimmed.match(/!\s*([1-9]|10)\s*$/);
  let withoutRating = trimmed;
  if (ratingMatch) {
    rating = Number(ratingMatch[1]);
    withoutRating = trimmed.slice(0, ratingMatch.index).trim();
  }

  // pull time override like "(9am)" or "(09:30)" "(9:30pm)"
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

// Parses time token like "9am", "11pm", "9:30", "09:30pm"
function parseTimeTokenToHourMinute(token) {
  if (!token) return null;
  const t = token.toLowerCase().replace(/\s+/g, "");

  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3] || null;

  if (minute < 0 || minute > 59) return null;
  if (hour < 0 || hour > 23) return null;

  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "am") hour = hour === 12 ? 0 : hour;
    if (ampm === "pm") hour = hour === 12 ? 12 : hour + 12;
  }

  return { hour, minute };
}

// For GN override: interpret "11pm" as the most recent occurrence of that time (usually last night).
function computeBedtimeUtcFromOverride(timeToken) {
  const now = DateTime.now().setZone(DEFAULT_TZ);
  const hm = parseTimeTokenToHourMinute(timeToken);
  if (!hm) return null;

  let candidate = now.set({ hour: hm.hour, minute: hm.minute, second: 0, millisecond: 0 });
  if (candidate > now) candidate = candidate.minus({ days: 1 }); // "11pm" when it's 2pm means last night
  return candidate.toUTC().toISO();
}

// For GM override: time is the next occurrence after the bed time.
function computeWakeUtcFromOverride(timeToken, bedIsoUtc) {
  const hm = parseTimeTokenToHourMinute(timeToken);
  if (!hm) return null;

  const bedLocal = DateTime.fromISO(bedIsoUtc, { zone: "utc" }).setZone(DEFAULT_TZ);

  let wakeLocal = bedLocal.set({ hour: hm.hour, minute: hm.minute, second: 0, millisecond: 0 });

  // ensure wake > bed
  if (wakeLocal <= bedLocal) wakeLocal = wakeLocal.plus({ days: 1 });

  return wakeLocal.toUTC().toISO();
}

function minutesBetween(isoUtcA, isoUtcB) {
  const a = DateTime.fromISO(isoUtcA, { zone: "utc" });
  const b = DateTime.fromISO(isoUtcB, { zone: "utc" });
  return Math.round(b.diff(a, "minutes").minutes);
}

// ---------- Bot ----------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Watching channel ${SLEEP_CHANNEL_ID} in tz=${DEFAULT_TZ}`);
});

async function promptRating(message) {
  await message.reply("Quick check-in: reply with `!1`–`!10` for how energetic you felt today (10 = great).");
}

async function promptMissingGM(message) {
  await message.reply(
    "I saw two `gn` in a row. Did you forget a good morning? You can log it retroactively like: `gm (9am)`"
  );
}

async function remindRatingOnGM(message) {
  await message.reply("Reminder: you still owe an energy rating for yesterday. Reply with `!1`–`!10`.");
}

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== SLEEP_CHANNEL_ID) return;

    const userId = message.author.id;
    const username = message.author.username;
    const raw = message.content;

    const parsed = parseMessage(raw);

    // Handle rating-only message: "!5"
    if (parsed.kind === "RATING_ONLY") {
      const target = db.lastSessionNeedingRating(userId);
      if (!target) {
        // No pending rating: ignore or inform
        await message.react("❓").catch(() => {});
        return;
      }
      db.setRating(target.id, parsed.rating);
      db.recordCheckin(userId, username, "RATING", new Date().toISOString(), raw);
      await message.react("✅").catch(() => {});
      return;
    }

    if (parsed.kind === "UNKNOWN") return;

    const nowIsoUtc = new Date().toISOString();

    // ---- GN ----
    if (parsed.kind === "GN") {
      // If there is a previous session still missing rating and a new GN arrives, omit it.
      const missingRating = db.lastSessionNeedingRating(userId);
      if (missingRating && missingRating.status === "CLOSED") {
        // user never answered; omit rating for that session
        db.omitRating(missingRating.id);
      }

      const open = db.getOpenSession(userId);
      if (open) {
        // consecutive GN before a GM -> prompt user to do GM(time)
        await promptMissingGM(message).catch(() => {});
      }

      const bedIsoUtc = parsed.timeToken ? computeBedtimeUtcFromOverride(parsed.timeToken) : nowIsoUtc;
      if (parsed.timeToken && !bedIsoUtc) {
        await message.reply("I couldn't parse that time. Try like `(11pm)` or `(9:30am)`").catch(() => {});
        return;
      }

      const sessionId = db.createSession(userId, username, bedIsoUtc);
      db.recordCheckin(userId, username, "GN", bedIsoUtc, raw);

      // rating embedded?
      if (parsed.rating != null) {
        db.setRating(sessionId, parsed.rating);
      } else {
        await promptRating(message).catch(() => {});
      }

      await message.react("🌙").catch(() => {});
      return;
    }

    // ---- GM ----
    if (parsed.kind === "GM") {
      const open = db.getOpenSession(userId);
      if (!open) {
        await message.reply("I don’t see an open sleep session (no prior `gn`). If you meant to start one, send `gn`.").catch(() => {});
        return;
      }

      const wakeIsoUtc = parsed.timeToken ? computeWakeUtcFromOverride(parsed.timeToken, open.bed_ts_utc) : nowIsoUtc;
      if (parsed.timeToken && !wakeIsoUtc) {
        await message.reply("I couldn't parse that time. Try like `(9am)` or `(7:15)`").catch(() => {});
        return;
      }

      const mins = minutesBetween(open.bed_ts_utc, wakeIsoUtc);
      db.closeSession(open.id, wakeIsoUtc, mins);
      db.recordCheckin(userId, username, "GM", wakeIsoUtc, raw);

      // If rating still missing, remind now (per your rules)
      const needsRating = db.lastSessionNeedingRating(userId);
      if (needsRating && needsRating.id === open.id) {
        await remindRatingOnGM(message).catch(() => {});
      }

      await message.react("☀️").catch(() => {});
      return;
    }
  } catch (err) {
    console.error("Error:", err);
  }
});

// Optional: export command: "!export"
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== SLEEP_CHANNEL_ID) return;

    const raw = message.content.trim();
    if (raw !== "!export") return;

    if (ADMIN_USER_ID && message.author.id !== ADMIN_USER_ID) {
      await message.reply("Not allowed.").catch(() => {});
      return;
    }

    const rows = db.sessionsForExport();

    const exportsDir = path.join(process.cwd(), "exports");
    fs.mkdirSync(exportsDir, { recursive: true });

    const outPath = path.join(exportsDir, "sleep_sessions.csv");
    const header = ["user_id","username","bed_ts_utc","wake_ts_utc","sleep_minutes","rating_1_10","rating_status"];
    const lines = [header.join(",")];

    for (const r of rows) {
      const vals = header.map((k) => (r[k] == null ? "" : String(r[k]).replaceAll('"', '""')));
      lines.push(vals.map(v => `"${v}"`).join(","));
    }

    fs.writeFileSync(outPath, lines.join("\n"), "utf8");
    await message.reply("Exported to `exports/sleep_sessions.csv` on the machine hosting the bot.").catch(() => {});
  } catch (err) {
    console.error("Export error:", err);
  }
});

// Clean shutdown
process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

client.login(TOKEN);
