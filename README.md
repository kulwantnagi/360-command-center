# 360° Command Center

One private website to plan and run your presence on LinkedIn, Instagram, Facebook, X, Threads and the bi-weekly AI newsletter.

- **Today**: a daily checklist built from your posting cadence, plus streak and week scorecard
- **Calendar**: week grid by platform, with dashed slots for what the cadence expects
- **Idea Pipeline**: kanban with one-click repurposing across every platform
- **Newsletter**: bi-weekly issue tracker with subscriber and open-rate log
- **X & Threads**: three tweet slots, reply counter, chat schedule, tweet bank
- **Reels**: five-stage production pipeline, cross-posted to Facebook
- **Growth**: weekly numbers with trend charts and 90-day goals
- **Playbook** and **Settings**

Data lives on the server, so the dashboard is the same on your laptop and phone, and the same for your whole team.

## Team and roles

| Role | Can do |
|---|---|
| **Owner** | Everything, plus invite people, change roles, remove members. There is one owner: you. |
| **Editor** | Plan and edit everything on the dashboard |
| **Viewer** | See everything, change nothing. The page goes read-only and the server refuses saves |

**Inviting someone**: Team tab, enter their email, pick a role, click "Create invite link". Send the link on WhatsApp or email. It works once, expires in 7 days, and the person chooses their own name and password. Pending invites can be cancelled from the same tab.

**Your first account**: the owner account is created on the first start from `OWNER_EMAIL`, `OWNER_NAME` and `DASHBOARD_PASSWORD`. After that, change your password under Settings → Your account. The env values are ignored once an account exists.

**Forgot the owner password?** Stop the server, delete the users (the file `data/team.json`, or the `users` table in Postgres), set a new `DASHBOARD_PASSWORD`, start again. Invited members would need new invites.

The Team tab also shows who saved the dashboard last. If two people edit at the same moment, the later save is refused and that person sees the newer copy with a note of who saved it.

## Run it locally

```bash
npm install
cp .env.example .env      # set DASHBOARD_PASSWORD (and SESSION_SECRET)
npm start                 # http://localhost:3000
```

With no `DATABASE_URL`, data is stored in `data/`: `state.json` is the dashboard, `team.json` holds accounts and invites. Back up the folder.

## Environment variables

| Variable | Required | What it does |
|---|---|---|
| `OWNER_EMAIL` | first start | Email of the owner account, used to sign in |
| `OWNER_NAME` | no | Display name of the owner, default "Owner" |
| `DASHBOARD_PASSWORD` | first start | Owner's first password, 8+ characters. Change it inside the dashboard afterwards |
| `SESSION_SECRET` | recommended | Signs the login cookie. Without it, a restart signs everyone out |
| `BASE_URL` | recommended in production | Public address used in invite links, e.g. `https://dashboard.yourdomain.com` |
| `PORT` | no | Port to listen on, default 3000 |
| `DATABASE_URL` | no | Postgres connection string. Set it to use a database instead of the JSON file |
| `DATA_DIR` | no | Folder for `state.json` when there is no database |
| `PGSSL` | no | `verify` (default), `disable` for a local Postgres, `no-verify` for self-signed certs |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Deploy

### Option A: Docker on any VPS (Hostinger, DigitalOcean, Hetzner)

```bash
git clone <your repo> kn360 && cd kn360
cp .env.example .env && nano .env          # set the password and secret
docker compose up -d --build
```

The site is on port 3000. Put Nginx or Caddy in front for HTTPS. Caddy needs two lines:

```
dashboard.yourdomain.com {
  reverse_proxy localhost:3000
}
```

Data is kept in the `dashboard-data` Docker volume. To back it up:

```bash
docker compose cp dashboard:/app/data/state.json ./backup-$(date +%F).json
```

### Option B: Node directly on a VPS with PM2

```bash
npm ci --omit=dev
cp .env.example .env && nano .env
npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

### Option C: A platform host (Render, Railway, Fly.io, Hostinger Node hosting)

1. Push this folder to a Git repo.
2. Create a new web service from the repo. Build command `npm ci`, start command `npm start`.
3. Add the environment variables from the table above.
4. Use Postgres for storage on these hosts. Their disks are usually wiped on each deploy, so the JSON file would not survive. A free Neon database works: create one, copy its connection string into `DATABASE_URL`. The table is created automatically on first start.

### Using Neon Postgres

```
DATABASE_URL=postgres://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require
```

Nothing else to configure. The server creates three tables on first start: `dashboard_state` (one JSON document), `users` and `invites`.

## Moving your data

- **From the old single-file version**: open the old dashboard, Settings, "Copy backup to clipboard". Open the new site, Settings, paste into "Restore", click restore.
- **Between hosts**: same steps. Or copy the `data/` folder, or the `dashboard_state`, `users` and `invites` tables.

## How saving works

Every change is saved about half a second after you make it. The footer shows "Saved", "Saving…" or "Offline". If two devices edit at once, the later save is refused and that device reloads the newer copy, so nothing is silently overwritten. A local browser cache keeps the last state visible if the server is unreachable.

## Health check

`GET /healthz` returns `{"ok":true,"store":"file"}` or `"postgres"`. Use it for uptime monitors and Docker health checks.
