// src/commands/export.js
const { AttachmentBuilder } = require("discord.js");
const { safeReply } = require("../utils");

async function handleExport(message, db) {
  const rows = db.sessionsForExport();

  if (rows.length === 0) {
    await safeReply(message, "No completed sessions to export yet.");
    return;
  }

  const header = ["user_id","username","bed_ts_utc","wake_ts_utc","sleep_minutes","rating_1_10","rating_status","note"];
  const lines = [header.join(",")];

  for (const r of rows) {
    const vals = header.map((k) => (r[k] == null ? "" : String(r[k]).replaceAll('"', '""')));
    lines.push(vals.map(v => `"${v}"`).join(","));
  }

  const csv = lines.join("\n");

  try {
    const file = new AttachmentBuilder(Buffer.from(csv, "utf8"), { name: "sleep_sessions.csv" });
    await message.author.send({
      content: `Here's the full export (${rows.length} sessions).`,
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
}

module.exports = { handleExport };
