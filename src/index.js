// src/index.js
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { initDb } = require("./db");
const { parseMessage } = require("./parse");
const { handleExport } = require("./commands/export");
const { handleReset } = require("./commands/reset");
const { handleUndo } = require("./commands/undo");
const { generateWeeklySummary } = require("./commands/summary");
const { handleRatingOnly, handleGN, handleGM, processPendingGNs } = require("./handlers/checkin");
const { registerSlashCommands, handleSlashInteraction } = require("./slash");
const { DateTime } = require("luxon");

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

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Watching channel ${SLEEP_CHANNEL_ID} tz=${DEFAULT_TZ}`);
  console.log(`DB: ${DB_PATH}`);

  // Register slash commands (keeps text commands working too)
  try {
    await registerSlashCommands(client, TOKEN);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }

  // Check if we should send weekly summary on startup
  await checkAndSendWeeklySummary();

  // Check for weekly summary every hour
  setInterval(async () => {
    await checkAndSendWeeklySummary();
  }, 60 * 60 * 1000); // Every hour
});

async function checkAndSendWeeklySummary() {
  try {
    const now = DateTime.now().setZone(DEFAULT_TZ);
    const today = now.toFormat("yyyy-MM-dd");
    const dayOfWeek = now.weekday; // 1 = Monday, 7 = Sunday

    // Only send on Mondays
    if (dayOfWeek !== 1) return;

    // Check if we already sent today
    const lastSummaryDate = db.getLastSummaryDate();
    if (lastSummaryDate === today) return;

    // Generate and send summary
    const channel = await client.channels.fetch(SLEEP_CHANNEL_ID);
    if (!channel) {
      console.error("Could not fetch sleep channel for weekly summary");
      return;
    }

    const summary = await generateWeeklySummary(db, DEFAULT_TZ);
    await channel.send(summary);

    // Mark as sent
    db.setLastSummaryDate(today);
    console.log(`📊 Weekly summary sent for ${today}`);
  } catch (err) {
    console.error("Error sending weekly summary:", err);
  }
}

// Slash command handler
client.on("interactionCreate", async (interaction) => {
  await handleSlashInteraction(interaction, db, DEFAULT_TZ, ADMIN_USER_ID, SLEEP_CHANNEL_ID);
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

    // Undo command
    if (raw.trim() === "!undo") {
      await handleUndo(message, db);
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
