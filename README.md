# SleepBot 💤

A Discord bot for lightweight sleep tracking with natural-language check-ins. Users log **good night / good morning**, optionally override times, rate daily energy, and add contextual notes. The bot automatically computes sleep duration and handles edge cases intelligently. Data is stored locally in SQLite and can be exported to CSV.

---

## Features

### Natural Language Check-ins

* **Good Night**: `gn`, `good night`, `goodnight`, `gngn`, `night`, `good nite`
* **Good Morning**: `gm`, `good morning`, `goodmorning`, `morning`

### Time Overrides

Retroactively log sleep times or specify exact times:

* `gn (11pm)` - Log bedtime at 11 PM
* `gm (9am)` - Log wake time at 9 AM
* `gn (9:00 am)` - 12-hour format with minutes
* `gm (21:15)` - 24-hour format
* Ambiguous times (e.g., `(9)`) are intelligently inferred from context

### Energy Ratings (1–10)

Track energy levels at different times:

* **Evening Rating** (how energetic you felt today):
  * **Inline**: `gn (11pm) !8` - Rate energy when logging bedtime
  * **Follow-up**: Reply with `!5` after receiving a prompt
* **Morning Rating** (how energetic you feel right now):
  * **Inline**: `gm !3` - Rate energy when logging wake time
  * **Follow-up**: Reply with `!5` after receiving a prompt
* Ratings are optional but encouraged; missing ratings are automatically omitted if a new session starts

### Session Notes

Add qualitative context to sleep sessions:

* **Bedtime notes** (what you were doing before sleep):
  * `gn !5 (9pm) "pset grinding"` - Add a note when logging bedtime
  * `gn "studying" !8` - Notes can appear anywhere after the command
* **Morning notes** (how you feel when waking up):
  * `gm !3 "slept poorly"` - Add a note when logging wake time
  * `gm "feeling refreshed" !7` - Notes can appear anywhere after the command
* Notes are stored in the database and included in CSV exports

### Smart Session Management

The bot intelligently handles common edge cases:

* **Consecutive Good Nights**: If you say `gn` twice in a row, the bot prompts you to complete the first session with `gm (time)`. The second `gn` is recorded but not immediately processed. If you don't fix it within an hour, the old session is automatically skipped and the new one becomes active.

* **Automatic Cleanup**: Sessions older than 1 hour are automatically cleaned up when a new `gn` is detected.

* **Retroactive Completion**: Use `gm (time)` with a past time to retroactively complete a previous session.

### Weekly Summaries

Every Monday, the bot automatically sends a weekly summary to the sleep channel with:

* Total number of sleep sessions
* Average hours slept
* Longest and shortest sleep sessions
* Average energy rating
* List of contributors

### Data Export

* `!export` - Receive a CSV file via DM containing all completed sleep sessions
* CSV includes: user ID, username, bed time, wake time, sleep duration, evening energy rating, rating status, morning energy rating, bedtime note, and morning note

### Data Management

* `!reset last` - Undo your most recent entry (safe; prevents multiple rollbacks)
* `!reset all` - Wipe all data (admin only, requires `ADMIN_USER_ID` in environment)

---

## Commands Reference

### Check-ins

| Command | Description |
|---------|-------------|
| `gn` | Log bedtime (current time) |
| `gn (11pm)` | Log bedtime with time override |
| `gn !8` | Log bedtime with evening energy rating |
| `gn (11pm) !8 "studying"` | Log bedtime with time, rating, and note |
| `gm` | Log wake time (current time) |
| `gm (9am)` | Log wake time with time override |
| `gm !3` | Log wake time with morning energy rating |
| `gm !3 "slept poorly"` | Log wake time with rating and note |
| `!5` | Rate energy level (1-10) as follow-up (prioritizes morning, then evening) |

### Utility Commands

| Command | Description | Access |
|---------|-------------|--------|
| `!export` | Export all completed sessions to CSV | Anyone |
| `!reset last` | Undo your most recent entry | Anyone |
| `!reset all` | Wipe all data | Admin only |

---

## Data Model

### Sessions Table

One row per sleep session:

* `id` - Primary key
* `user_id` - Discord user ID
* `username` - Discord username (snapshot at session creation)
* `bed_ts_utc` - Bedtime timestamp (UTC ISO format)
* `wake_ts_utc` - Wake time timestamp (UTC ISO format, nullable)
* `sleep_minutes` - Calculated sleep duration in minutes
* `rating_1_10` - Evening energy rating (1-10, nullable) - how energetic you felt during the day
* `rating_status` - `MISSING`, `RECORDED`, or `OMITTED` (for evening rating)
* `morning_energy_rating` - Morning energy rating (1-10, nullable) - how energetic you feel right now
* `status` - `OPEN` or `CLOSED`
* `note` - Optional bedtime note (text, nullable) - what you were doing before sleep
* `gm_note` - Optional morning note (text, nullable) - how you feel when waking up

### Checkins Table

Audit trail of all recognized messages:

* `id` - Primary key
* `user_id` - Discord user ID
* `username` - Discord username (snapshot)
* `kind` - `GN`, `GM`, or `RATING`
* `ts_utc` - Timestamp (UTC ISO format)
* `raw_content` - Original message content

### Pending GN Table

Tracks good night checkins that were recorded but didn't create sessions (when user says `gn` while another session is open):

* `user_id` - Discord user ID
* `checkin_id` - Reference to checkins table
* `bed_ts_utc` - Bedtime timestamp
* `raw_content` - Original message content
* `created_at_utc` - When the pending GN was created
* `note` - Optional note from the command

### Weekly Summary State Table

Tracks when weekly summaries were last sent to avoid duplicates:

* `last_summary_date` - Date (YYYY-MM-DD format) of the last summary sent

---

## Setup

### Prerequisites

* Node.js 18 or higher
* npm
* Discord Bot Token
* Discord Server with appropriate permissions

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/RikarusCode/SleepBot.git
   cd SleepBot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory:
   ```env
   DISCORD_TOKEN=your_bot_token_here
   SLEEP_CHANNEL_ID=your_channel_id_here
   DEFAULT_TZ=America/Los_Angeles
   DB_PATH=./sleep.sqlite
   ADMIN_USER_ID=your_discord_user_id_here
   ```

   **Required:**
   - `DISCORD_TOKEN` - Your Discord bot token
   - `SLEEP_CHANNEL_ID` - The Discord channel ID where the bot should listen

   **Optional:**
   - `DEFAULT_TZ` - Default timezone (defaults to `America/Los_Angeles`)
   - `DB_PATH` - Path to SQLite database file (defaults to `./sleep.sqlite`)
   - `ADMIN_USER_ID` - Discord user ID for admin commands (optional)

4. Run the bot:
   ```bash
   npm start
   ```

### Discord Bot Setup

1. Create a Discord application at https://discord.com/developers/applications
2. Create a bot and copy the token
3. Invite the bot to your server with the following permissions:
   - Send Messages
   - Read Message History
   - Read Messages/View Channels
   - Use External Emojis (optional, for reactions)

---

## Hosting

### Render (Recommended)

Use a **Background Worker** service type with a **Persistent Disk** attached so the SQLite database survives restarts.

1. Connect your GitHub repository
2. Set environment variables in the Render dashboard
3. Use the build command: `npm install`
4. Use the start command: `npm start`
5. Add a persistent disk and mount it to store `sleep.sqlite`

### Other Platforms

Any Node.js hosting platform that supports:
* Persistent file storage (for SQLite database)
* Long-running processes
* Environment variable configuration

---

## Privacy & Security

* **Local Storage**: All data is stored locally in SQLite. The database file is not committed to Git.
* **Environment Variables**: Sensitive tokens and IDs are stored in `.env` or host environment variables, never in code.
* **Data Export**: The `!export` command sends CSV files via DM. Users should be aware that exported data includes their user ID and sleep patterns.
* **No External Services**: The bot does not send data to any external services or APIs beyond Discord.

---

## Architecture

The codebase is organized into modular components:

* `src/index.js` - Main entry point, Discord client setup, message routing, weekly summary scheduling
* `src/parse.js` - Message parsing and time computation logic
* `src/db.js` - Database initialization and SQLite operations
* `src/handlers/checkin.js` - Check-in handling logic (GN, GM, ratings)
* `src/commands/export.js` - CSV export functionality
* `src/commands/reset.js` - Data reset commands
* `src/commands/summary.js` - Weekly summary generation and formatting
* `src/utils.js` - Utility functions and user prompts

---

## License

ISC

