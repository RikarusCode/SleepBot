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
const { resolveTargetUser } = require("./utils");
const { DateTime } = require("luxon");

const TOKEN = process.env.DISCORD_TOKEN;
const SLEEP_CHANNEL_ID = process.env.SLEEP_CHANNEL_ID;
const DB_PATH = process.env.DB_PATH || "./sleep.sqlite";
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Los_Angeles";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN) {
  console.error("❌ CRITICAL: DISCORD_TOKEN missing from environment variables");
  console.error("Please set DISCORD_TOKEN in Render dashboard Environment tab");
  process.exit(1);
}
if (!SLEEP_CHANNEL_ID) {
  console.error("❌ CRITICAL: SLEEP_CHANNEL_ID missing from environment variables");
  console.error("Please set SLEEP_CHANNEL_ID in Render dashboard Environment tab");
  process.exit(1);
}

console.log("🔧 Environment check:");
console.log(`  DISCORD_TOKEN: ${TOKEN ? "✅ Set" : "❌ Missing"}`);
console.log(`  SLEEP_CHANNEL_ID: ${SLEEP_CHANNEL_ID ? "✅ Set" : "❌ Missing"}`);
console.log(`  DB_PATH: ${DB_PATH}`);
console.log(`  DEFAULT_TZ: ${DEFAULT_TZ}`);
console.log(`  ADMIN_USER_ID: ${ADMIN_USER_ID || "Not set"}`);
console.log(`  GUILD_ID: ${GUILD_ID || "Not set"}`);

console.log(`💾 Initializing database at: ${DB_PATH}`);
let db;
try {
  db = initDb(DB_PATH);
  console.log("✅ Database initialized successfully");
} catch (dbError) {
  console.error("❌ Failed to initialize database:", dbError);
  console.error("Database error details:", {
    message: dbError.message,
    code: dbError.code,
    errno: dbError.errno
  });
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Add error handlers for better debugging
client.on("error", (error) => {
  console.error("❌ Discord client error:", error);
  console.error("Error details:", {
    message: error.message,
    code: error.code,
    name: error.name
  });
});

client.on("warn", (warning) => {
  console.warn("⚠️ Discord client warning:", warning);
});

client.on("disconnect", (event) => {
  console.warn("⚠️ Discord client disconnected");
  console.warn("Disconnect event:", {
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean
  });
});

client.on("reconnecting", () => {
  console.log("🔄 Discord client reconnecting...");
});

// WebSocket connection events
client.on("shardDisconnect", (event, id) => {
  console.warn(`⚠️ Shard ${id} disconnected:`, {
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean
  });
});

client.on("shardError", (error, id) => {
  console.error(`❌ Shard ${id} error:`, error);
});

client.on("shardReconnecting", (id) => {
  console.log(`🔄 Shard ${id} reconnecting...`);
});

client.on("shardReady", (id) => {
  console.log(`✅ Shard ${id} ready`);
});

// Debug WebSocket connection
client.on("debug", (info) => {
  // Only log important debug info, not everything
  if (info.includes("WebSocket") || info.includes("Heartbeat") || info.includes("error")) {
    console.log(`🔍 [DEBUG] ${info}`);
  }
});

client.once("ready", async () => {
  console.log("=".repeat(50));
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  console.log(`📡 Bot ID: ${client.user.id}`);
  console.log(`👀 Watching channel: ${SLEEP_CHANNEL_ID}`);
  console.log(`🌍 Timezone: ${DEFAULT_TZ}`);
  console.log(`💾 Database: ${DB_PATH}`);
  console.log(`🔗 Gateway: ${client.ws.gateway}`);
  console.log(`📊 Guilds: ${client.guilds.cache.size}`);
  console.log("=".repeat(50));

  // Verify channel access
  try {
    const channel = await client.channels.fetch(SLEEP_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ ERROR: Channel ${SLEEP_CHANNEL_ID} not found or bot doesn't have access`);
    } else {
      console.log(`✅ Channel verified: #${channel.name} (${channel.id})`);
    }
  } catch (err) {
    console.error(`❌ ERROR: Failed to fetch channel ${SLEEP_CHANNEL_ID}:`, err.message);
  }

  // Register slash commands (keeps text commands working too)
  try {
    console.log("📝 Registering slash commands...");
    await registerSlashCommands(client, TOKEN, GUILD_ID);
    console.log("✅ Slash commands registered successfully");
  } catch (err) {
    console.error("❌ Failed to register slash commands:", err);
  }

  // Check if we should send weekly summary on startup
  try {
    await checkAndSendWeeklySummary();
  } catch (err) {
    console.error("❌ Error checking weekly summary on startup:", err);
  }

  // Check for weekly summary every hour
  setInterval(async () => {
    try {
      await checkAndSendWeeklySummary();
    } catch (err) {
      console.error("❌ Error in weekly summary interval:", err);
    }
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
      await handleReset(message, raw, db, ADMIN_USER_ID, client);
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

    // Handle admin targeting (if userParam is specified)
    let targetUserId = userId;
    let targetUsername = username;
    if (parsed.userParam) {
      const targetUser = await resolveTargetUser(message, parsed.userParam, ADMIN_USER_ID, client);
      if (targetUser) {
        targetUserId = targetUser.id;
        targetUsername = targetUser.username;
        console.log(`[ADMIN] ${username} (${userId}) executing command for ${targetUsername} (${targetUserId})`);
      } else {
        await message.reply("❌ Could not resolve target user or you don't have admin permissions.");
        return;
      }
    }

    if (parsed.kind === "RATING_ONLY") {
      await handleRatingOnly(message, parsed, targetUserId, targetUsername, raw, db);
      return;
    }

    if (parsed.kind === "GN") {
      await handleGN(message, parsed, targetUserId, targetUsername, raw, db, DEFAULT_TZ);
      return;
    }

    if (parsed.kind === "GM") {
      await handleGM(message, parsed, targetUserId, targetUsername, raw, db, DEFAULT_TZ);
      return;
    }
  } catch (err) {
    console.error("Error:", err);
  }
});

// Global error handlers
process.on("unhandledRejection", (error) => {
  console.error("❌ Unhandled promise rejection:", error);
  console.error("Rejection details:", {
    message: error.message,
    code: error.code,
    name: error.name,
    stack: error.stack?.split('\n').slice(0, 10).join('\n')
  });
  // Don't exit - let the process continue and log the error
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught exception:", error);
  db.close();
  process.exit(1);
});

// Clean shutdown
process.on("SIGINT", () => {
  console.log("🛑 Received SIGINT, shutting down gracefully...");
  db.close();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM, shutting down gracefully...");
  db.close();
  client.destroy();
  process.exit(0);
});

// Start the bot
console.log("🚀 Starting Discord bot...");
console.log(`🔑 Token length: ${TOKEN ? TOKEN.length : 0} characters`);
console.log(`🔑 Token starts with: ${TOKEN ? TOKEN.substring(0, 10) + '...' : 'N/A'}`);

// Validate token format
if (!TOKEN.match(/^[A-Za-z0-9._-]+$/)) {
  console.error("❌ Invalid token format: Token contains invalid characters");
  process.exit(1);
}

// Test token by making a REST API call before WebSocket login
async function validateToken() {
  try {
    console.log("🔍 Validating token with Discord API...");
    const https = require('https');
    const url = 'https://discord.com/api/v10/users/@me';
    
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'Authorization': `Bot ${TOKEN}`,
          'User-Agent': 'SleepBot/1.0.0'
        },
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const user = JSON.parse(data);
              console.log(`✅ Token valid! Bot username: ${user.username}#${user.discriminator}`);
              console.log(`   Bot ID: ${user.id}`);
              resolve(true);
            } catch (e) {
              console.error("❌ Failed to parse Discord API response:", e);
              reject(e);
            }
          } else {
            console.error(`❌ Token validation failed: HTTP ${res.statusCode}`);
            console.error(`   Response: ${data.substring(0, 200)}`);
            if (res.statusCode === 401) {
              console.error("   This means the token is INVALID or EXPIRED");
            }
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });
      
      req.on('error', (error) => {
        console.error("❌ Network error validating token:", error.message);
        console.error("   This might indicate network connectivity issues from Render");
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        console.error("❌ Token validation timeout - Discord API not reachable");
        reject(new Error('Timeout'));
      });
    });
  } catch (error) {
    console.error("❌ Error during token validation:", error);
    throw error;
  }
}

// Set a timeout to detect if login hangs
const loginTimeout = setTimeout(() => {
  console.error("❌ Login timeout: Bot failed to connect within 30 seconds");
  console.error("This usually means:");
  console.error("  1. Invalid DISCORD_TOKEN");
  console.error("  2. Network connectivity issues");
  console.error("  3. Discord API is down");
  console.error("  4. Bot account is disabled or banned");
  process.exit(1);
}, 30000); // 30 second timeout

// Validate token first, then login
validateToken()
  .then(() => {
    console.log("🔌 Token validated, attempting WebSocket connection...");
    return client.login(TOKEN);
  })
  .then(() => {
    clearTimeout(loginTimeout);
    console.log("✅ Login promise resolved, waiting for 'ready' event...");
  })
  .catch((error) => {
    clearTimeout(loginTimeout);
    console.error("❌ Failed to login to Discord:", error);
    console.error("Error details:", {
      message: error.message,
      code: error.code,
      name: error.name,
      stack: error.stack?.split('\n').slice(0, 10).join('\n')
    });
    console.error("\nTroubleshooting:");
    console.error("  1. Verify DISCORD_TOKEN in Render dashboard matches your bot token");
    console.error("  2. Check Discord Developer Portal: https://discord.com/developers/applications");
    console.error("  3. Ensure bot is not disabled or banned");
    console.error("  4. Try regenerating the token");
    console.error("  5. Check Render network/firewall settings");
    process.exit(1);
  });
