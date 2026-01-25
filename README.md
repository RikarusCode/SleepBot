# SleepBot 💤

A Discord bot for lightweight sleep tracking with natural-language check-ins. Users log **good night / good morning**, optionally override times, rate daily energy, and the bot automatically computes sleep duration. Data is stored locally in SQLite and can be exported to CSV.

---

## Features

* **Natural language check-ins**

  * `gn`, `good night`, `gm`, `good morning`, etc.
* **Time overrides**

  * Examples: `gn (11pm)`, `gm (9am)`, `gn (9:00 am)`, `gm (21:15)`
  * Ambiguous times (e.g. `(9)`) are inferred sensibly from context.
* **Energy rating (1–10)**

  * Inline: `gn (11pm) !8`
  * Or prompted follow-up: reply with `!5`
* **Smart prompts & guards**

  * Warns on consecutive `gn` / `gm`
  * Prompts for missing ratings and safely omits if unanswered
* **Automatic sleep duration**

  * Pairs `gn → gm` and computes minutes slept
* **Exports & resets**

  * `!export` → DM CSV (admin only)
  * `!reset last` → delete your most recent datapoint (guarded)
  * `!reset all` → wipe all data (admin only)

---

## Commands

### Check-ins

* `gn` / `good night`
* `gm` / `good morning`

### Time Overrides

* `gn (11pm)`
* `gm (9am)`
* `gn (9:00 am)`
* `gm (21:15)`

### Ratings

* Inline with GN: `gn !8`
* Follow-up only: `!5`

### Admin / Utility

* `!export` — DM a CSV of all closed sessions (anyone can use this, be careful with privacy concerns)
* `!reset last` — delete *your* most recent entry (safe; won’t delete older ones)
* `!reset all` — wipe **all** data (admin only)

---

## Data Model (SQLite)

### sessions

One row per sleep session.

* `user_id`, `username`
* `bed_ts_utc`, `wake_ts_utc`
* `sleep_minutes`
* `rating_1_10` (nullable)
* `rating_status`: `MISSING | RECORDED | OMITTED`
* `status`: `OPEN | CLOSED`

### checkins

Audit trail of recognized messages.

---

## Local Setup

### Requirements

* Node.js 18+
* npm

### Install

```bash
npm install
```

### Run Locally

```bash
npm start
```

---

## Hosting (Render – Recommended)

Use a **Background Worker** with a **Persistent Disk** so SQLite survives restarts.

---

## Privacy & Safety

* Tokens and secrets live only in `.env` / host environment variables
* SQLite database is **not** committed to Git
