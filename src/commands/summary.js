// src/commands/summary.js
const { DateTime } = require("luxon");

function formatHours(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function calculateWeeklySummary(sessions, defaultTz) {
  if (sessions.length === 0) {
    return null;
  }

  // Filter to valid sessions only
  const validSessions = sessions.filter(s => s.sleep_minutes != null && s.sleep_minutes > 0);
  if (validSessions.length === 0) {
    return null;
  }

  // Group sessions by user and by day (using wake_ts_utc to determine which day)
  // This allows naps + main sleep to be combined into total daily sleep
  const dailySleep = {}; // key: "user_id:YYYY-MM-DD" -> total minutes
  
  validSessions.forEach(s => {
    if (!s.wake_ts_utc) return; // Skip sessions without wake time
    
    // Determine which day this session belongs to (based on wake time)
    const wakeTime = DateTime.fromISO(s.wake_ts_utc, { zone: "utc" }).setZone(defaultTz);
    const dayKey = `${s.user_id}:${wakeTime.toFormat("yyyy-MM-dd")}`;
    
    dailySleep[dayKey] = (dailySleep[dayKey] || 0) + s.sleep_minutes;
  });

  // Calculate average sleep per day (not per session)
  // This way naps + main sleep = total daily sleep
  const dailyTotals = Object.values(dailySleep);
  if (dailyTotals.length === 0) {
    return null;
  }

  const totalMinutes = dailyTotals.reduce((sum, minutes) => sum + minutes, 0);
  const avgMinutes = Math.round(totalMinutes / dailyTotals.length);
  const avgHours = (avgMinutes / 60).toFixed(1);

  // Find longest and shortest sessions (still session-level, not day-level)
  const sorted = [...validSessions].sort((a, b) => a.sleep_minutes - b.sleep_minutes);
  const longest = sorted[sorted.length - 1];
  const shortest = sorted[0];

  // Count sessions per user and track user IDs for mentions
  const userCounts = {};
  const userIds = new Set();
  sessions.forEach(s => {
    userCounts[s.username] = (userCounts[s.username] || 0) + 1;
    userIds.add(s.user_id);
  });

  // Calculate average energy rating (if available)
  const ratedSessions = sessions.filter(s => s.rating_1_10 != null);
  const avgRating = ratedSessions.length > 0
    ? (ratedSessions.reduce((sum, s) => sum + s.rating_1_10, 0) / ratedSessions.length).toFixed(1)
    : null;

  return {
    totalSessions: sessions.length,
    totalDays: dailyTotals.length, // Number of days with sleep logged
    avgHours,
    avgMinutes,
    longest: {
      minutes: longest.sleep_minutes,
      username: longest.username,
      formatted: formatHours(longest.sleep_minutes),
    },
    shortest: {
      minutes: shortest.sleep_minutes,
      username: shortest.username,
      formatted: formatHours(shortest.sleep_minutes),
    },
    userCounts,
    userIds: Array.from(userIds),
    avgRating,
    ratedCount: ratedSessions.length,
  };
}

function formatWeeklySummary(stats, startDate, endDate) {
  if (!stats) {
    return `📊 **Weekly Sleep Summary**\n\nNo completed sleep sessions this week.`;
  }

  const start = DateTime.fromISO(startDate).toFormat("MMM d");
  const end = DateTime.fromISO(endDate).minus({ days: 1 }).toFormat("MMM d");
  
  let summary = `📊 **Weekly Sleep Summary** (${start} - ${end})\n\n`;
  summary += `**Total Sessions:** ${stats.totalSessions}\n`;
  summary += `**Days Logged:** ${stats.totalDays}\n`;
  summary += `**Average Sleep per Day:** ${stats.avgHours} hours\n\n`;
  
  summary += `**Longest Single Session:** ${stats.longest.formatted} (${stats.longest.username})\n`;
  summary += `**Shortest Single Session:** ${stats.shortest.formatted} (${stats.shortest.username})\n`;

  if (stats.avgRating) {
    summary += `\n**Average Energy Rating:** ${stats.avgRating}/10 (${stats.ratedCount} sessions rated)`;
  }

  // Ping all contributors if multiple users
  if (stats.userIds.length > 1) {
    const mentions = stats.userIds.map(id => `<@${id}>`).join(" ");
    summary += `\n\n**Contributors:** ${mentions}`;
  }

  return summary;
}

async function generateWeeklySummary(db, defaultTz) {
  const now = DateTime.now().setZone(defaultTz);
  const endDate = now.startOf("day").toUTC().toISO();
  const startDate = now.minus({ days: 7 }).startOf("day").toUTC().toISO();

  const sessions = db.sessionsForWeeklySummary(startDate, endDate);
  const stats = calculateWeeklySummary(sessions, defaultTz);
  
  return formatWeeklySummary(stats, startDate, endDate);
}

module.exports = {
  generateWeeklySummary,
};
