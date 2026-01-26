// src/utils.js

async function safeReply(message, text) {
  try {
    await message.reply(text);
  } catch {
    // If Send Messages is missing, replies will fail—no crash.
  }
}

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

module.exports = {
  safeReply,
  promptRating,
  promptMissingGM,
  promptConsecutiveGM,
  remindRatingOnGM,
};
