# SleepBot 💤

A Discord bot for lightweight sleep tracking with natural-language check-ins **and structured slash commands**. Users log **good night / good morning**, optionally override times, rate daily and morning energy, and add contextual notes. The bot automatically computes sleep duration, handles edge cases intelligently, and stores data locally in SQLite for export to CSV.

---

## Features

### Natural Language & Slash Command Check-ins

- **Good Night**  
  - Text: `gn`, `good night`, `goodnight`, `gngn`, `night`, `good nite`  
  - Slash: `/gn`
- **Good Morning**  
  - Text: `gm`, `good morning`, `goodmorning`, `morning`  
  - Slash: `/gm`
- **Standalone Ratings**  
  - Text: `!5` (1–10)  
  - Slash: `/rate value:5`

Text commands and slash commands are fully compatible: slash commands internally build the equivalent text form and go through the same parsing and session logic.

### Time Overrides

Retroactively log sleep times or specify exact times:

- `gn (11pm)` – Log bedtime at 11 PM  
- `gm (9am)` – Log wake time at 9 AM  
- `gn (9:00 am)` – 12‑hour format with minutes  
- `gm (21:15)` – 24‑hour format  
- Ambiguous times (e.g., `(9)`) are inferred from context (bed vs. wake, day boundary, etc.).

Slash commands expose this as a `time` string option, e.g. `/gn time:"11pm"`, `/gm time:"9am"`.

### Energy Ratings (1–10)

Track energy levels at two points:

- **Evening Rating** (how energetic you felt during the day)
  - Text:
    - Inline: `gn (11pm) !8` – rate when logging bedtime
    - Follow‑up: reply with `!5` after the bot prompts
  - Slash:
    - `/gn rating:8`
    - `/rate value:5`
- **Morning Rating** (how energetic you feel right now when waking)
  - Text:
    - Inline: `gm !3`
    - Follow‑up: reply with `!5` after a morning‑rating prompt
  - Slash:
    - `/gm rating:3`
    - `/rate value:5`

Ratings are optional but encouraged. If you repeatedly ignore rating prompts and start a new session, past missing ratings can be safely omitted.

### Session Notes

Add qualitative context to each sleep session:

- **Bedtime notes** (what you were doing before sleep)
  - Text: `gn !5 (9pm) "pset grinding"`, `gn "studying" !8` (quotes can appear anywhere after `gn`)
  - Slash: `/gn note:"pset grinding"`
- **Morning notes** (how you feel when waking up)
  - Text: `gm !3 "slept poorly"`, `gm "feeling refreshed" !7`
  - Slash: `/gm note:"slept poorly"`

Notes are stored in the database (`note` / `gm_note`) and included in CSV exports.

### Smart Session Management

The bot is opinionated about keeping sessions consistent, while staying forgiving:

- **Consecutive Good Nights (`gn` → `gn`)**  
  If you say `gn` twice in a row:
  - The bot **prompts you** to complete the previous session with `gm (time)` first.
  - The second `gn` is **secretly recorded** as a pending session but not used yet.
  - If you don’t fix the previous session within **1 hour**, the old session is automatically skipped and the pending `gn` becomes the active session.

- **Automatic Cleanup**  
  Pending `gn`s and stale open sessions are cleaned up once they are more than 1 hour old and a new `gn` appears.

- **Retroactive Completion**  
  Use `gm (time)` (e.g. `gm (9am)`) to retroactively close an older session. The bot tries to match the most reasonable open session based on duration and timing.

- **Rating Prompts (Priority Order)**  
  1. Session consistency (missing `gm`)  
  2. Missing evening rating  
  3. Missing morning rating  

### Weekly Summaries

Every Monday, the bot automatically posts a weekly summary in the configured sleep channel:

- Total number of completed sleep sessions  
- Average hours slept  
- Longest and shortest sleep sessions (with usernames)  
- Average evening energy rating (if available)  
- Mentions all contributors who logged sleep that week

Summaries are stored in a `weekly_summary_state` table so each Monday’s summary is only sent once.

### Data Export

- Text: `!export` – receive a CSV via DM containing all completed sessions.  
- CSV columns include:
  - `user_id`, `username`
  - `bed_ts_utc`, `wake_ts_utc`
  - `sleep_minutes`
  - `rating_1_10`, `rating_status`
  - `morning_energy_rating`
  - `note` (bedtime note)
  - `gm_note` (morning note)

### Data Management & Undo

- Text: `!reset last` – reset your most recent check‑in (gn, gm, or rating).  
  - The bot replies with exactly what was reset (e.g., `♻️ Reset your last entry: \`!5\``).
  - Internally, the full checkin + session state is pushed onto an undo stack.
- Text: `!undo` – undo the last `!reset last`, restoring both the checkin and any affected session state.  
  - Multiple `!undo` calls walk back through your recent resets.
- Text: `!reset all` – wipe **all** data (sessions, checkins, pending state, weekly summary state, undo state).  
  - Admin only: requires `ADMIN_USER_ID` in the environment.

Slash equivalents:

- `/export`, `/reset scope:last`, `/reset scope:all`, `/undo`

---

## Commands Reference

### Slash Commands (Recommended)

| Command | Options | Description |
|--------|---------|-------------|
| `/gn` | `rating?`, `time?`, `note?` | Log bedtime (current time or override), optionally add evening rating and bedtime note. |
| `/gm` | `rating?`, `time?`, `note?` | Log wake time (current time or override), optionally add morning rating and note. |
| `/rate` | `value` (1–10) | Add a standalone energy rating (prefers pending morning rating, then evening). |
| `/export` | – | Export all completed sessions to CSV (DM). |
| `/reset` | `scope` = `last` \| `all` | Reset last entry, or wipe all data (admin only for `all`). |
| `/undo` | – | Undo the most recent reset operation (stack‑based, can be called multiple times). |

### Legacy Text Commands (Still Supported)

#### Check-ins

| Command | Description |
|---------|-------------|
| `gn` | Log bedtime (current time). |
| `gn (11pm)` | Log bedtime with time override. |
| `gn !8` | Log bedtime with evening energy rating. |
| `gn (11pm) !8 "studying"` | Log bedtime with time, rating, and note. |
| `gm` | Log wake time (current time). |
| `gm (9am)` | Log wake time with time override. |
| `gm !3` | Log wake time with morning energy rating. |
| `gm !3 "slept poorly"` | Log wake time with rating and note. |
| `!5` | Standalone energy rating (1–10); prioritizes missing morning rating, then evening. |

#### Utility

| Command | Description | Access |
|---------|-------------|--------|
| `!export` | Export all completed sessions to CSV. | Anyone |
| `!reset last` | Reset your most recent entry and push it onto the undo stack. | Anyone |
| `!undo` | Undo the last reset operation; can be repeated. | Anyone |
| `!reset all` | Wipe all sessions and checkins. | Admin only |

---

## Data Model

### Sessions Table

One row per sleep session:

- `id` – Primary key  
- `user_id` – Discord user ID  
- `username` – Discord username (snapshot at session creation)  
- `bed_ts_utc` – Bedtime timestamp (UTC ISO)  
- `wake_ts_utc` – Wake time timestamp (UTC ISO, nullable)  
- `sleep_minutes` – Calculated sleep duration in minutes  
- `rating_1_10` – Evening energy rating (1–10, nullable) – how energetic you felt during the day  
- `rating_status` – `MISSING`, `RECORDED`, or `OMITTED` (for evening rating)  
- `morning_energy_rating` – Morning energy rating (1–10, nullable) – how energetic you feel right now  
- `status` – `OPEN` or `CLOSED`  
- `note` – Optional bedtime note (text, nullable) – what you were doing before sleep  
- `gm_note` – Optional morning note (text, nullable) – how you feel when waking up  

### Checkins Table

Audit trail of all recognized messages:

- `id` – Primary key  
- `user_id` – Discord user ID  
- `username` – Discord username (snapshot)  
- `kind` – `GN`, `GM`, or `RATING`  
- `ts_utc` – Timestamp (UTC ISO format)  
- `raw_content` – Original message content  

### Pending GN Table

Tracks `gn` checkins that were recorded but not yet converted into a full session (used when a new `gn` arrives while another session is open):

- `user_id` – Discord user ID  
- `checkin_id` – Reference to `checkins.id`  
- `bed_ts_utc` – Bedtime timestamp for the pending session  
- `raw_content` – Original message content  
- `created_at_utc` – When the pending `gn` was created  
- `note` – Optional bedtime note from the command  

### Weekly Summary State Table

Ensures weekly summaries are sent at most once per Monday:

- `last_summary_date` – Date (`YYYY-MM-DD`) of the last summary that was sent  

### Undo State Table

Stack‑like storage for undoing resets:

- `id` – Primary key (`AUTOINCREMENT`)  
- `user_id` – Discord user ID  
- `checkin_id` – ID of the checkin that was reset (nullable)  
- `checkin_kind` – Type of checkin (`GN`, `GM`, `RATING`)  
- `checkin_ts_utc` – Timestamp of the original checkin  
- `checkin_raw_content` – Original message content  
- `checkin_username` – Username at time of checkin  
- `session_id` – Related session ID (if applicable)  
- `session_data` – JSON snapshot of the session state before reset  
- `undo_type` – Logical type of operation (`GN`, `GM`, `RATING_EVENING`, `RATING_MORNING`, etc.)  
- `created_at_utc` – When this undo record was created  
- Unique constraint on (`user_id`, `checkin_id`) to avoid duplicates  

---

## Setup

### Prerequisites

- Node.js 18 or higher  
- npm  
- Discord Bot Token  
- Discord server where you can invite the bot  

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

   - `DISCORD_TOKEN` – Your Discord bot token  
   - `SLEEP_CHANNEL_ID` – The Discord channel ID where the bot should listen and post weekly summaries  

   **Optional:**

   - `DEFAULT_TZ` – Default timezone (defaults to `America/Los_Angeles`)  
   - `DB_PATH` – Path to SQLite database file (defaults to `./sleep.sqlite`)  
   - `ADMIN_USER_ID` – Discord user ID that can run `!reset all` / `/reset scope:all`  

4. Run the bot:

   ```bash
   npm start
   ```

### Discord Bot Setup

1. Create a Discord application at `https://discord.com/developers/applications`.  
2. Create a bot user and copy the bot token into `.env`.  
3. Under **OAuth2 → URL Generator**, select:
   - Scopes: `bot`, `applications.commands`  
   - Bot permissions: at minimum:
     - Send Messages  
     - Read Message History  
     - Read Messages/View Channels  
     - Use External Emojis (optional, for reactions)  
4. Invite the bot to your server using the generated URL.

---

## Hosting

### Render (Recommended)

Use a **Background Worker** service type with a **Persistent Disk** so the SQLite database survives restarts.

1. Connect your GitHub repository.  
2. Set environment variables in the Render dashboard.  
3. Build command: `npm install`  
4. Start command: `npm start`  
5. Attach a persistent disk and mount it where `sleep.sqlite` lives.  

### Other Platforms

Any Node.js hosting platform that supports:

- Persistent file storage (for SQLite)  
- Long‑running processes  
- Environment variable configuration  

---

## Privacy & Security

- **Local Storage** – All data is stored locally in SQLite. The database file is ignored by Git.  
- **Environment Variables** – Tokens and IDs live in `.env` or host env vars, not in code.  
- **Data Export** – CSV exports are delivered via DM and contain user IDs and sleep history. Handle them as sensitive data.  
- **No External Services** – The bot only talks to Discord; there are no third‑party analytics or APIs.

---

## Architecture

The codebase is organized into modular components:

- `src/index.js` – Main entry point, Discord client setup, text message routing, weekly summary scheduling, slash registration.  
- `src/slash.js` – Slash command definitions and routing into existing handlers.  
- `src/parse.js` – Parsing of text commands into structured intents, time parsing helpers.  
- `src/db.js` – Database initialization, schema migrations, and all SQLite operations.  
- `src/handlers/checkin.js` – Core check‑in logic (GN, GM, ratings, pending GNs, prompts).  
- `src/commands/export.js` – CSV export logic.  
- `src/commands/reset.js` – `!reset` / `/reset` logic and undo‑state capture.  
- `src/commands/undo.js` – `!undo` / `/undo` logic and session restoration.  
- `src/commands/summary.js` – Weekly summary calculations and formatting.  
- `src/utils.js` – Shared utility functions and user‑facing prompt text.  

---

## License

ISC
