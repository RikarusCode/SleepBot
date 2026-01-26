// src/index.js
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { initDb } = require("./db");
const { parseMessage } = require("./parse");
const { handleExport } = require("./commands/export");
const { handleReset } = require("./commands/reset");
const { handleRatingOnly, handleGN, handleGM, processPendingGNs } = require("./handlers/checkin");

const TOKEN = process.env.DISCORD_TOKEN;
const SLEEP_CHANNEL_ID = process.env.SLEEP_CHANNEL_ID;
const DB_PATH = process.env.DB_PATH || "./sleep.sqlite";
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Los_Angeles";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || null;

if (!TOKEN) throw new Error("DISCORD_TOKEN missing from .env");
if (!SLEEP_CHANNEL_ID) throw new Error("SLEEP_CHANNEL_ID missing from .env");

const db = initDb(DB_PATH);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Watching channel ${SLEEP_CHANNEL_ID} tz=${DEFAULT_TZ}`);
  console.log(`DB: ${DB_PATH}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== SLEEP_CHANNEL_ID) return;

    // Process any pending GNs that are now 1+ hours old
    processPendingGNs(db, DEFAULT_TZ);

    const userId = message.author.id;
    const username = message.author.username;
    const raw = message.content;

    // Export command
    if (raw.trim() === "!export") {
      await handleExport(message, db);
      return;
    }

    // Reset commands
    if (raw.trim().startsWith("!reset")) {
      await handleReset(message, raw, db, ADMIN_USER_ID);
      return;
    }

    // Parse and handle checkins
    const parsed = parseMessage(raw);
    if (parsed.kind === "UNKNOWN") return;

    if (parsed.kind === "RATING_ONLY") {
      await handleRatingOnly(message, parsed, userId, username, raw, db);
      return;
    }

    if (parsed.kind === "GN") {
      await handleGN(message, parsed, userId, username, raw, db, DEFAULT_TZ);
      return;
    }

    if (parsed.kind === "GM") {
      await handleGM(message, parsed, userId, username, raw, db, DEFAULT_TZ);
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
