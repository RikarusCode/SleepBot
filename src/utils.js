// src/utils.js

async function safeReply(message, text) {
  try {
    await message.reply(text);
  } catch (err) {
    // If Send Messages is missing, replies will fail—no crash.
    // Try sending to channel as fallback
    try {
      await message.channel.send(text);
    } catch (err2) {
      console.error("Failed to send message:", err2.message);
    }
  }
}

async function promptRating(message) {
  await safeReply(message, "Quick check-in: reply with `!1`–`!10` for how energetic you felt today (10 = great).");
}

async function promptMissingGM(message) {
  await safeReply(
    message,
    "Looks like you have two `gn` in a row. Please update the existing session with `gm (time)`, then redo your current `gn`. If you do not do this within an hour, your old session will be skipped."
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

async function promptMorningEnergy(message) {
  await safeReply(message, "Quick check-in: reply with `!1`–`!10` for how energetic you feel right now (10 = great).");
}

async function remindMorningEnergy(message) {
  await safeReply(message, "Reminder: you still owe a morning energy rating. Reply with `!1`–`!10` for how energetic you feel right now.");
}

module.exports = {
  safeReply,
  promptRating,
  promptMissingGM,
  promptConsecutiveGM,
  remindRatingOnGM,
  promptMorningEnergy,
  remindMorningEnergy,
};
