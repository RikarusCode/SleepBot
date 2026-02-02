// src/slash.js
const {
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const { parseMessage } = require("./parse");
const { handleGN, handleGM, handleRatingOnly, processPendingGNs } = require("./handlers/checkin");
const { handleExport } = require("./commands/export");
const { handleReset } = require("./commands/reset");
const { handleUndo } = require("./commands/undo");

function buildSlashCommands() {
  const commands = [];

  // /gn
  commands.push(
    new SlashCommandBuilder()
      .setName("gn")
      .setDescription("Log good night / going to bed")
      .addIntegerOption((option) =>
        option
          .setName("rating")
          .setDescription("Evening energy rating 1–10")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(10),
      )
      .addStringOption((option) =>
        option
          .setName("time")
          .setDescription("Bedtime override, e.g. 11pm or 23:15")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("note")
          .setDescription("What you were doing (e.g. \"pset grinding\")")
          .setRequired(false),
      ),
  );

  // /gm
  commands.push(
    new SlashCommandBuilder()
      .setName("gm")
      .setDescription("Log good morning / waking up")
      .addIntegerOption((option) =>
        option
          .setName("rating")
          .setDescription("Morning energy rating 1–10")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(10),
      )
      .addStringOption((option) =>
        option
          .setName("time")
          .setDescription("Wake time override, e.g. 9am or 07:30")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("note")
          .setDescription("How you slept / context (e.g. \"slept poorly\")")
          .setRequired(false),
      ),
  );

  // /rate – standalone rating (!1–!10)
  commands.push(
    new SlashCommandBuilder()
      .setName("rate")
      .setDescription("Add a standalone energy rating (evening or morning)")
      .addIntegerOption((option) =>
        option
          .setName("value")
          .setDescription("Rating 1–10")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10),
      ),
  );

  // /export
  commands.push(
    new SlashCommandBuilder()
      .setName("export")
      .setDescription("Export all completed sessions as CSV (DM)"),
  );

  // /reset
  commands.push(
    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("Reset your last entry or (admin) wipe all data")
      .addStringOption((option) =>
        option
          .setName("scope")
          .setDescription("What to reset")
          .setRequired(true)
          .addChoices(
            { name: "last", value: "last" },
            { name: "all (admin only)", value: "all" },
          ),
      ),
  );

  // /undo
  commands.push(
    new SlashCommandBuilder()
      .setName("undo")
      .setDescription("Undo your most recent reset"),
  );

  return commands;
}

async function registerSlashCommands(client, token, guildId) {
  const commands = buildSlashCommands().map((cmd) => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    // When using guild-specific commands, clear any old global commands to avoid duplicates
    try {
      await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
      console.log("🧹 Cleared global application commands");
    } catch (err) {
      console.error("Failed to clear global commands (safe to ignore in dev):", err);
    }

    // Fast install for a single guild (updates immediately)
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
      body: commands,
    });
    console.log(`✅ Registered slash commands for guild ${guildId}`);
  } else {
    // Global commands (can take up to ~1 hour to appear)
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("✅ Registered global slash commands");
  }
}

function makeMessageAdapterFromInteraction(interaction) {
  // Adapter that looks like a Message enough for existing handlers/utils
  return {
    id: interaction.id,
    author: interaction.user,
    channelId: interaction.channelId,
    reply: async (content) => {
      if (interaction.replied || interaction.deferred) {
        return interaction.followUp({ content });
      }
      return interaction.reply({ content });
    },
    react: async () => {
      // No reactions for slash commands – no-op to keep handlers working
      return;
    },
    channel: {
      id: interaction.channelId,
      send: async (content) => {
        if (interaction.replied || interaction.deferred) {
          return interaction.followUp({ content });
        }
        return interaction.reply({ content });
      },
    },
  };
}

async function handleSlashInteraction(interaction, db, defaultTz, adminUserId, sleepChannelId) {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (sleepChannelId && interaction.channelId !== sleepChannelId) return;

    // Keep GN pending cleanup logic consistent with text commands
    processPendingGNs(db, defaultTz);

    const userId = interaction.user.id;
    const username = interaction.user.username;

    const messageLike = makeMessageAdapterFromInteraction(interaction);

    if (interaction.commandName === "gn") {
      // Extract and normalize rating (handle !5 format)
      let rating = interaction.options.getInteger("rating");
      if (rating == null) {
        const ratingStr = interaction.options.getString("rating")?.trim();
        if (ratingStr) {
          const ratingMatch = ratingStr.match(/^!?\s*([1-9]|10)$/);
          if (ratingMatch) rating = Number(ratingMatch[1]);
        }
      }

      // Extract and normalize time (handle (9am) format)
      let time = interaction.options.getString("time")?.trim();
      if (time) {
        // Remove parentheses if user included them
        time = time.replace(/^\(|\)$/g, "").trim();
      }

      // Extract and normalize note (handle "note" format)
      let note = interaction.options.getString("note")?.trim();
      if (note) {
        // Remove quotes if user included them (handles both regular and smart quotes)
        note = note.replace(/^[""«»]|[""«»]$/g, "").trim();
      }

      let raw = "gn";
      if (rating != null) raw += ` !${rating}`;
      if (time) raw += ` (${time})`;
      if (note) raw += ` "${note}"`;

      const parsed = parseMessage(raw);
      if (parsed.kind !== "GN" && parsed.kind !== "RATING_ONLY") {
        await interaction.reply({ content: "I couldn't understand that `gn` command.", ephemeral: true });
        return;
      }

      await handleGN(messageLike, parsed, userId, username, raw, db, defaultTz);

      // Text handlers often only react; for slash we must send a visible response
      if (!interaction.replied && !interaction.deferred) {
        let replyText = "🌙 Logged good night.";
        if (note) {
          replyText += ` Note: ${note}`;
        }
        await interaction.reply({ content: replyText });
      }
      return;
    }

    if (interaction.commandName === "gm") {
      // Extract and normalize rating (handle !5 format)
      let rating = interaction.options.getInteger("rating");
      if (rating == null) {
        const ratingStr = interaction.options.getString("rating")?.trim();
        if (ratingStr) {
          const ratingMatch = ratingStr.match(/^!?\s*([1-9]|10)$/);
          if (ratingMatch) rating = Number(ratingMatch[1]);
        }
      }

      // Extract and normalize time (handle (9am) format)
      let time = interaction.options.getString("time")?.trim();
      if (time) {
        // Remove parentheses if user included them
        time = time.replace(/^\(|\)$/g, "").trim();
      }

      // Extract and normalize note (handle "note" format)
      let note = interaction.options.getString("note")?.trim();
      if (note) {
        // Remove quotes if user included them (handles both regular and smart quotes)
        note = note.replace(/^[""«»]|[""«»]$/g, "").trim();
      }

      let raw = "gm";
      if (rating != null) raw += ` !${rating}`;
      if (time) raw += ` (${time})`;
      if (note) raw += ` "${note}"`;

      const parsed = parseMessage(raw);
      if (parsed.kind !== "GM") {
        await interaction.reply({ content: "I couldn't understand that `gm` command.", ephemeral: true });
        return;
      }

      await handleGM(messageLike, parsed, userId, username, raw, db, defaultTz);

      if (!interaction.replied && !interaction.deferred) {
        let replyText = "☀️ Logged good morning.";
        if (note) {
          replyText += ` Note: ${note}`;
        }
        await interaction.reply({ content: replyText });
      }
      return;
    }

    if (interaction.commandName === "rate") {
      const value = interaction.options.getInteger("value");
      const raw = `!${value}`;
      const parsed = parseMessage(raw);
      if (parsed.kind !== "RATING_ONLY") {
        await interaction.reply({ content: "I couldn't understand that rating.", ephemeral: true });
        return;
      }

      await handleRatingOnly(messageLike, parsed, userId, username, raw, db);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "✅ Logged rating.", ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === "export") {
      await handleExport(messageLike, db);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "📩 Export requested. Check your DMs.", ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === "reset") {
      const scope = interaction.options.getString("scope");
      const raw = `!reset ${scope}`;
      await handleReset(messageLike, raw, db, adminUserId);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "♻️ Processed reset command.", ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === "undo") {
      await handleUndo(messageLike, db);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "✅ Processed undo command.", ephemeral: true });
      }
      return;
    }
  } catch (err) {
    console.error("Error handling slash interaction:", err);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "Something went wrong handling that command.", ephemeral: true });
      } catch {
        // ignore
      }
    }
  }
}

module.exports = {
  registerSlashCommands,
  handleSlashInteraction,
};

