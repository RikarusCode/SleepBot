# SleepBot 💤

> A Discord bot for effortless sleep tracking with natural language commands and intelligent session management.

Simply say "good night" and "good morning" to automatically track your sleep patterns, energy levels, and habits.

## ✨ Features

### 🎯 Dual Command Interface
- **Slash Commands** – Modern, structured commands with autocomplete (`/gn`, `/gm`, `/rate`)
- **Text Commands** – Natural language support (`gn`, `gm`, `!5`) for quick check-ins
- Both interfaces work seamlessly together with the same underlying logic

### ⏰ Flexible Time Tracking
- Automatic timestamping or manual overrides
- Retroactive logging for forgotten entries
- Smart time parsing (handles `11pm`, `9:00 am`, `21:15`, and ambiguous formats)
- Automatic correction of misinterpreted times (e.g., `11:45` PM vs AM)

### 📊 Comprehensive Sleep Analytics
- **Daily Sleep Aggregation** – Naps and main sleep combined per day for accurate averages
- **Weekly Summaries** – Automatic Monday reports with averages, longest/shortest sessions, and energy ratings
- **CSV Export** – Full data export via DM for personal analysis
- **Multi-User Support** – Track multiple users in the same server

### 🧠 Intelligent Session Management
- **Smart Error Recovery** – Handles consecutive `gn` commands gracefully
- **Pending Session Queue** – Automatically manages forgotten check-ins
- **Retroactive Completion** – Match wake times to the correct bedtime session
- **Automatic Cleanup** – Removes stale sessions after 1 hour

### 💪 Energy & Context Tracking
- **Evening Ratings** – Track how energetic you felt during the day (1–10)
- **Morning Ratings** – Log how you feel when waking up
- **Session Notes** – Add context like "pset grinding" or "slept poorly"
- **Smart Prompts** – Prioritized reminders for missing data

### 🔄 Data Management
- **Undo System** – Stack-based undo for accidental resets
- **Admin Controls** – Execute commands on behalf of other users
- **Reset & Recovery** – Safely reset entries with full state restoration

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Discord Bot Token
- A Discord server

### Installation

1. **Clone and install:**
   ```bash
   git clone https://github.com/RikarusCode/SleepBot.git
   cd SleepBot
   npm install
   ```

2. **Configure environment:**
   Create a `.env` file:
   ```env
   DISCORD_TOKEN=your_bot_token_here
   SLEEP_CHANNEL_ID=your_channel_id_here
   DEFAULT_TZ=America/Los_Angeles
   ADMIN_USER_ID=your_discord_user_id_here
   GUILD_ID=your_server_id_here
   ```

3. **Run the bot:**
   ```bash
   npm start
   ```

### Discord Bot Setup

1. Create a Discord application at [discord.com/developers](https://discord.com/developers/applications)
2. Create a bot user and copy the token to `.env`
3. Under **OAuth2 → URL Generator**, select:
   - **Scopes:** `bot`, `applications.commands`
   - **Bot Permissions:** Send Messages, Read Message History, Read Messages/View Channels
4. Invite the bot using the generated URL

## 📖 Commands

### Slash Commands

| Command | Options | Description |
|---------|---------|-------------|
| `/gn` | `rating?`, `time?`, `note?`, `user?` | Log bedtime with optional evening rating, time override, and note. Admin can specify `user` to log for others. |
| `/gm` | `rating?`, `time?`, `note?`, `user?` | Log wake time with optional morning rating, time override, and note. |
| `/rate` | `value` (1–10), `user?` | Add a standalone energy rating (prioritizes morning, then evening). |
| `/export` | – | Export all completed sessions to CSV (delivered via DM). |
| `/reset` | `scope` (`last` \| `all`), `user?` | Reset last entry or wipe all data (admin only for `all`). |
| `/undo` | – | Undo the most recent reset operation (stack-based). |

### Text Commands

#### Check-ins
- `gn` – Log bedtime (current time)
- `gn (11pm)` – Log bedtime with time override
- `gn !8` – Log bedtime with evening energy rating
- `gn (11pm) !8 "studying"` – Full example with time, rating, and note
- `gm` – Log wake time (current time)
- `gm (9am)` – Log wake time with override
- `gm !3 "slept poorly"` – Wake time with morning rating and note
- `!5` – Standalone energy rating (1–10)

#### Utility
- `!export` – Export all sessions to CSV
- `!reset last` – Reset your most recent entry
- `!undo` – Undo the last reset
- `!reset all` – Wipe all data (admin only)

#### Admin Commands
- `gn @user !7 (11pm)` – Log for another user
- `!reset last @user` – Reset another user's entry

## 🎨 Key Features Explained

### Smart Time Parsing
SleepBot intelligently handles various time formats and ambiguous inputs:

```bash
gn (11pm)        # 12-hour format
gm (9:00 am)     # With minutes
gn (21:15)       # 24-hour format
gm (9)           # Ambiguous - inferred from context
```

The bot automatically corrects misinterpreted times. For example, if you log `gn (11:45)` in the morning, it understands you meant 11:45 PM the previous night.

### Daily Sleep Aggregation
SleepBot groups all sleep sessions by day, so naps and main sleep are combined:

- **Monday:** 8 hours (main) + 1 hour (nap) = **9 hours total**
- **Tuesday:** 7 hours (main) = **7 hours total**
- **Average:** 8 hours per day (not per session)

Skipped days don't affect your average—only days with logged sleep are counted.

### Intelligent Session Recovery
When you forget to log a good morning:

1. Bot prompts you to complete the previous session
2. Your next `gn` is secretly recorded as pending
3. After 1 hour, the old session auto-skips and pending becomes active
4. You can retroactively complete with `gm (9am)` anytime

### Weekly Summaries
Every Monday, SleepBot automatically posts:
- Total sessions and days logged
- Average sleep per day (combining naps)
- Longest and shortest single sessions
- Average energy ratings
- Mentions all contributors

## 🗄️ Data Model

### Core Tables

**Sessions** – One row per sleep session
- Sleep duration, timestamps, ratings, notes, status

**Checkins** – Audit trail of all commands
- User, timestamp, command type, raw content

**Pending GN** – Queue for forgotten check-ins
- Tracks `gn` commands waiting for session completion

**Undo State** – Stack-based undo system
- Full state snapshots for reset recovery

**Weekly Summary State** – Prevents duplicate summaries
- Tracks last summary date

## 🏗️ Architecture

The codebase is organized into focused modules:

```
src/
├── index.js           # Main entry, Discord client, routing
├── slash.js           # Slash command definitions & routing
├── parse.js           # Natural language parsing & time handling
├── db.js              # SQLite operations & schema management
├── handlers/
│   └── checkin.js     # Core GN/GM/rating logic
├── commands/
│   ├── export.js      # CSV export
│   ├── reset.js       # Reset & undo state management
│   ├── undo.js         # Undo operations
│   └── summary.js     # Weekly summary calculations
└── utils.js           # Shared utilities & prompts
```

## 🌐 Hosting

### Render (Recommended)
1. Create a **Background Worker** service
2. Attach a **Persistent Disk** for SQLite
3. Set environment variables
4. Deploy with `npm start`

### Other Platforms
Any Node.js host with:
- Persistent file storage (for SQLite)
- Long-running processes
- Environment variable support

## 🔒 Privacy & Security

- **100% Local Storage** – All data in SQLite, never leaves your server
- **No External Services** – Only communicates with Discord
- **Environment Variables** – Secrets never in code
- **CSV Exports** – Delivered via DM, handle as sensitive data

## 🛠️ Tech Stack

- **Node.js** – Runtime environment
- **discord.js** – Discord API integration
- **better-sqlite3** – Fast, synchronous SQLite driver
- **luxon** – Timezone-aware date/time handling
- **dotenv** – Environment configuration

## 📝 License

ISC

---

**Built with ❤️ for better sleep tracking**
