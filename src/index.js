require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { initDb } = require("./db");

const TOKEN = process.env.DISCORD_TOKEN;
const SLEEP_CHANNEL_ID = process.env.SLEEP_CHANNEL_ID;
const DB_PATH = process.env.DB_PATH || "./sleep.sqlite";

if (!TOKEN) throw new Error("DISCORD_TOKEN missing from .env");
if (!SLEEP_CHANNEL_ID) throw new Error("SLEEP_CHANNEL_ID missing from .env");

const db = initDb(DB_PATH);

const GOODNIGHT = new Set(["gn", "goodnight", "good night", "gngn", "night", "good nite"]);
const GOODMORNING = new Set(["gm", "goodmorning", "good morning", "morning"]);

function normalize(s) {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function classify(content) {
  const t = normalize(content);
  if (GOODNIGHT.has(t)) return "GN";
  if (GOODMORNING.has(t)) return "GM";
  return null;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Watching channel ${SLEEP_CHANNEL_ID}`);
  console.log(`DB: ${DB_PATH}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== SLEEP_CHANNEL_ID) return;

  const eventType = classify(message.content);
  if (!eventType) return;

  const isoUtc = new Date().toISOString();
  db.recordEvent(
    message.author.id,
    message.author.username,
    eventType,
    isoUtc
  );  
  console.log(`[${isoUtc}] saved ${eventType} for ${message.author.tag}`);

  try {
    await message.react(eventType === "GN" ? "🌙" : "☀️");
  } catch {}
});

// Clean shutdown
process.on("SIGINT", () => {
  console.log("Shutting down...");
  db.close();
  process.exit(0);
});

client.login(TOKEN);
