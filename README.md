# CLuB-1962
Clothing company

## Club 1962 HQ

The Club 1962 dashboard: sales, inventory, expenses, customers, marketing, suppliers, monthly plans and efficiency checks. It replaces the Club 1962 Excel workbook and exports back to Excel when you need it.

There are two versions with the same screens:

- **Render app (this repo):** your own web address, owner and staff logins, live updates between phones, and it installs on a phone like a normal app.
- **Claude artifact:** https://claude.ai/artifact/8nPX6Cik4zxZDzRHR1r39d. Its source is kept unchanged in `artifact/index.html`.

The two don't sync with each other. Use **Backup** in one and **Restore** in the other to move data across.

## Who can do what

| | Owner | Staff |
|---|---|---|
| See everything | ✓ | ✓ |
| Log and edit sales, stock, expenses, customers, campaigns and suppliers | ✓ | ✓ |
| Edit monthly plans, tick off tasks, add improvements | ✓ | ✓ |
| Export to Excel and download a backup | ✓ | ✓ |
| Delete records | ✓ | |
| Restore a backup | ✓ | |
| Add staff, reset passwords, switch off access | ✓ | |

## Put it online (free)

These steps take about 15 minutes and use two free services: **Neon** for the database and **Render** for the website. They're the same steps as the SecureSpace storage app.

1. **Create the database.** Sign up at [neon.tech](https://neon.tech) and create a new project called `club-1962` (don't reuse the storage app's database). Choose the region *AWS US East (N. Virginia)*. Copy the **connection string**. It starts with `postgresql://`.
2. **Create the website.** Sign in at [render.com](https://render.com) with GitHub. Click **New → Blueprint** and pick the `CLuB-1962` repository (and the `claude/club-1962-dashboard` branch, until it's merged into `main`). Render reads `render.yaml` and asks for four values:
   - `DATABASE_URL`: the Neon connection string
   - `OWNER_USERNAME`: the username you'll sign in with, for example `joshua`
   - `OWNER_PASSWORD`: a strong password, at least 8 characters
   - `OWNER_NAME`: your name as it should appear in the app
3. Click **Apply**. After a few minutes you'll have an address like `https://club-1962-hq.onrender.com`. Open it and sign in.
4. **Load your history.** Tap **Restore** and pick `club1962-backup.json` (your sales, stock, expenses, plans and improvements). To get the newest copy, open the Claude artifact and tap **Backup** first.
5. **Add staff.** Tap **Account**, then under **Staff accounts** fill in their name, username and password, and tap **Add account**.

The owner account is created only the first time the app starts. After that, change passwords in the app under **Account**.

**About the free plan:** Render's free websites go to sleep after 15 minutes without visitors, so the first visit after a quiet spell takes about a minute to load. Render's **Starter** plan (US$7 a month) stays awake. Your data is stored in Neon either way.

**Your own web address:** in Render, open the service, go to **Settings → Custom Domains**, and add a domain like `app.club1962.com`.

> **Keep backups out of this repo.** It's public, and backup files contain customer names and phone numbers. `.gitignore` already blocks files named `*backup*.json`.

## Install it on a phone

- **Android (Chrome):** open the address and tap **Account → Install Club 1962 app**. Or use Chrome's ⋮ menu → **Install app**.
- **iPhone (Safari):** open the address, tap **Share**, then **Add to Home Screen**.

If the signal drops, the app still opens and shows the last saved data. Changes pause until you're back online.

## Run it on your own computer

You need [Node.js](https://nodejs.org) 22.5 or newer.

```bash
npm install
OWNER_USERNAME=owner OWNER_PASSWORD=choose-a-password npm start
```

Open <http://localhost:3000>. Without `DATABASE_URL`, data is saved in `data/club1962.db`.

Tests: `npm test`. To run them against Postgres as well, set `TEST_DATABASE_URL`, which **empties** that database.

## Backups

- **Neon** keeps a restore history (about the last day on the free plan).
- Tap **Backup** at month end and keep the file somewhere safe (not in this repo). **Export to Excel** gives you the same sheets as the original workbook.

## How it's built

- `server/`: Node.js + Express API, sessions in the database, scrypt password hashing, and live updates over Server-Sent Events. Each record is a JSON document, the same shape the Claude artifact uses, so backups work in both.
- `public/`: the dashboard in plain HTML, CSS and JavaScript with no build step, plus the web app manifest, service worker and icons (`npm run icons` regenerates the PNGs from `icons/icon.svg`).
- `artifact/index.html`: the Claude artifact version.
- `render.yaml`: Render hosting configuration.
