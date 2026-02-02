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
    "I saw two `gn` in a row. Please send a `gm (time)` first to complete your previous `gn`, then send your current goodnight message again."
  );
}

async function promptConsecutiveGM(message) {
  await safeReply(
    message,
    "I saw two `gm` in a row. Please send a `gn (time)` first to start the clock at when you went to bed, then send your current good morning message again."
  );
}

async function remindRatingOnGM(message) {
  await safeReply(message, "Reminder: you still owe an evening energy rating for last night. Reply with `!1`–`!10`.");
}

async function promptMorningEnergy(message) {
  await safeReply(message, "Quick check-in: reply with `!1`–`!10` for how energetic you feel right now (10 = great).");
}

async function remindMorningEnergy(message) {
  await safeReply(message, "Reminder: you still owe a morning energy rating. Reply with `!1`–`!10` for how energetic you feel right now.");
}

async function promptBothRatingsAfterGM(message) {
  await safeReply(
    message,
    "You still owe **two** energy ratings for this sleep: first send `!1`–`!10` for how energetic you felt yesterday, then send another `!1`–`!10` for how you feel right now."
  );
}

async function promptMorningAfterEvening(message) {
  await safeReply(
    message,
    "Got it for last night. Now send another `!1`–`!10` for how you feel right now this morning."
  );
}

// Helper to resolve a user from mention, username, or user ID (admin only)
async function resolveTargetUser(messageOrInteraction, userParam, adminUserId, client) {
  if (!userParam) return null;
  
  // Check if requester is admin
  const requesterId = messageOrInteraction.user?.id || messageOrInteraction.author?.id;
  if (!adminUserId || requesterId !== adminUserId) {
    return null; // Not admin or no admin configured
  }
  
  // Try to resolve user
  const trimmed = userParam.trim();
  
  // Try Discord mention format: <@123456789> or <@!123456789>
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    try {
      const user = await client.users.fetch(mentionMatch[1]);
      return { id: user.id, username: user.username };
    } catch (err) {
      return null;
    }
  }
  
  // Try user ID directly
  if (/^\d+$/.test(trimmed)) {
    try {
      const user = await client.users.fetch(trimmed);
      return { id: user.id, username: user.username };
    } catch (err) {
      return null;
    }
  }
  
  // Try username (exact match from guild members)
  if (messageOrInteraction.guild) {
    try {
      const members = await messageOrInteraction.guild.members.fetch();
      const member = members.find(m => 
        m.user.username.toLowerCase() === trimmed.toLowerCase() ||
        m.user.displayName.toLowerCase() === trimmed.toLowerCase()
      );
      if (member) {
        return { id: member.user.id, username: member.user.username };
      }
    } catch (err) {
      // Fall through
    }
  }
  
  return null;
}

module.exports = {
  safeReply,
  promptRating,
  promptMissingGM,
  promptConsecutiveGM,
  remindRatingOnGM,
  promptMorningEnergy,
  remindMorningEnergy,
  promptBothRatingsAfterGM,
  promptMorningAfterEvening,
  resolveTargetUser,
};
