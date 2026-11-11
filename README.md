# Movie Night

A small self-hosted web app for a recurring movie night among a few friends. Each night one participant (the **proposer**) suggests three movies and another (the **chooser**) picks which one gets watched. The app keeps the schedule, rotates the roles fairly, and shows the upcoming nights with their proposer, chooser, choices and pick.

- **Schedule:** one or more movie nights a week, each weekday with its own start time. Single nights can be moved, retimed or skipped.
- **Fair rotation:** everyone proposes and chooses once per round. Nobody gets the same role on consecutive nights, and the pairings vary.
- **Proposing:** search all of TMDB. The dialog also suggests movies that were passed over before (with how many times) and unwatched movies from the Jellyfin library.
- **Picking:** posters with a hover card showing rating, certification, runtime, a spoiler-light synopsis, director, cast, streaming services and a trailer link. The chooser picks from the card or the poster.
- **Sign-in:** Google login through Cloudflare Access. The app itself has no passwords.
- **Chat reminders:** optional Matrix messages when it's someone's turn, when a movie is picked, and on the day.

Built with [Bun](https://bun.sh), [Hono](https://hono.dev) and `bun:sqlite`, with a plain HTML/CSS/JS front end. There is no build step.

## How it works

**Roles.** Participants are listed in a rotation order in Settings. For n people the rotation is a fixed cycle of n×(n−1) nights in which every proposer/chooser pairing happens once. Each round of n nights has everyone proposing once and choosing once, and nobody gets the same role on consecutive nights. With 4 or more people, it also avoids having a night's chooser propose the next night. Around locked nights, the planner picks the arrangement with the fewest repeats.

**Calendar and lineup.** The *calendar* is the weekly schedule plus one-off changes: a skipped date, an extra date, or a custom start time. The *lineup* is the ordered queue of nights that have been locked in, meaning they have proposals, a pick or roles set by an admin. Lineup nights fill the calendar's upcoming dates in order. Adding or removing weekdays, skipping a date or moving a night never leaves a gap; the nights slide onto the next available dates and keep their roles, choices and pick. When a date passes, the night on it is recorded as held on that date.

**Open nights** after the lineup are planned from the rotation, continuing from the most recent night. A night that passes with nothing proposed carries its turn over to the next night. Proposing for a later open night locks in the open nights before it with the roles they were showing, so nothing shifts.

**Proposing and picking.** The proposer sets or changes the 3 choices until a movie is picked. The chooser picks, switches or undoes their pick until the night has passed. Admins can act for anyone with **Admin override**.

**Admin tools.** These are in **Settings** and on each night:
- **Participants:** add (by Google email), reorder the rotation, rename, change email, set a Matrix ID, make admin, or remove.
- **Settings:** the weekly nights and times, the timezone, and the rating region used for certifications and streaming.
- **Per night:** **Change date** (with **Back to regular schedule** to undo), **Skip this date** (skipped dates show with **Restore**), and **Edit roles**.

## Quick start (local)

Requires Bun 1.2+.

```sh
bun install
cp .env.example .env     # set TMDB_TOKEN at minimum
bun run dev              # http://localhost:8795
```

On first run there are no participants, so the page asks you to create the first one, who becomes the admin. Locally you sign in with the name picker, which only works from `localhost`. Use **Switch user** to act as other participants while testing.

```sh
bun test                 # API, rotation and scheduling tests (in-memory DB, fake TMDB/Jellyfin/Matrix)
bun run typecheck
```

## Configuration

All configuration is environment variables. Bun loads `.env` from the working directory automatically. Everything except `TMDB_TOKEN` is optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8795` | HTTP port (listens on all interfaces). |
| `DB_PATH` | `./data/movie-night.sqlite` | SQLite database file. The directory is created if needed. |
| `TMDB_TOKEN` | | TMDB "API Read Access Token" (v4), or a v3 API key. Needed for search and movie details. |
| `ACCESS_TEAM_DOMAIN` | | Cloudflare Access team domain, e.g. `yourteam.cloudflareaccess.com`. |
| `ACCESS_AUD` | | Access application AUD tag. Several can be listed, comma-separated (e.g. a wildcard app and a dedicated one). |
| `ADMIN_EMAILS` | | Comma-separated emails that are added as admin participants on their first sign-in. |
| `PUBLIC_URL` | | Public address of the app. Shown to people who need to sign in, and linked in chat messages. |
| `PICKER` | `localhost` | Name-picker sign-in without real authentication: `localhost` (this machine only, for development), `lan` (anyone who can reach the port; honor system) or `off`. |
| `JELLYFIN_URL` | | Jellyfin server, e.g. `http://localhost:8096`. |
| `JELLYFIN_API_KEY` | | Jellyfin API key (Dashboard → API Keys). |
| `MATRIX_HOMESERVER` | | Matrix homeserver URL, e.g. `https://matrix.example.com`. |
| `MATRIX_ACCESS_TOKEN` | | Access token of the bot account that posts messages. |
| `MATRIX_ROOM` | | Room to post in: a room ID (`!abc...`) or alias (`#movienight:example.com`). |

Everything else (participants, schedule, timezone, region) is set in the app under **Settings** and stored in the database.

### Sign-in and identity

- **Requests through Cloudflare** (they carry `Cf-Ray`/`Cf-Connecting-Ip` headers) must have a valid Cloudflare Access JWT. It's checked against `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and the email in it must belong to an active participant. If Access isn't configured, these requests are refused.
- **Direct requests** (no Cloudflare headers) use the name picker, subject to `PICKER`. With the default `localhost`, other devices on the network are told to use `PUBLIC_URL`, so nobody on the LAN can impersonate a participant.

### TMDB

Create a free account at themoviedb.org. Under Settings → API, request an API key, then copy the **API Read Access Token** into `TMDB_TOKEN`. Movie details are cached in the database for a week. The site footer carries TMDB's required attribution.

### Cloudflare Tunnel and Access

1. **Tunnel:** route a hostname to the app. For a locally managed tunnel, add an ingress rule above the catch-all in the cloudflared config, run `cloudflared tunnel route dns <tunnel> <hostname>`, and restart cloudflared:

   ```yaml
     - hostname: movienight.example.com
       service: http://localhost:8795
   ```

2. **Google login:** in the Zero Trust dashboard, go to Settings → Authentication and add **Google** as a login method. This needs a Google OAuth client:
   - Authorized JavaScript origin: `https://<team>.cloudflareaccess.com`
   - Redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
   - Publish the consent screen, or add each participant as a test user.

3. **Access application:** under Access → Applications, add a self-hosted app for the hostname. Use Google as the login method and allow the participants' emails.

4. **App config:** set `ACCESS_TEAM_DOMAIN`, and set `ACCESS_AUD` to the application's AUD tag. The tag also appears as the `kid=` parameter of the Access login redirect for the hostname.

### Jellyfin (optional)

Set `JELLYFIN_URL` and `JELLYFIN_API_KEY`. The proposal dialog then lists library movies that none of the participants has watched, and search results show **In library** and **Seen by …** badges.

- **Matching:** participants are matched to Jellyfin users by display name, so keep the names the same in both.
- **Caching:** the library list is cached for 10 minutes, and posters fall back to Jellyfin artwork until TMDB details are cached.

### Matrix notifications (optional)

Set `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` and `MATRIX_ROOM`. Give each participant a Matrix ID in Settings → Participants → **Matrix ID** so they get mentioned and pinged.

| When | Message |
|---|---|
| Proposals saved | The chooser is told it's their turn, with the three choices. Changed choices are announced too. |
| Movie picked | The pick is announced. |
| 2 days before, 10:00 | Proposer reminder, if there are no choices yet. |
| Day of, 10:00 | Proposer reminder if there are still no choices, or chooser reminder if nothing is picked. |
| Day of, 12:00 | "Tonight at 7:30 PM: ...", once a movie is picked. |

Times are in the configured timezone. Reminders are checked every 5 minutes, each is sent once (recorded in the `notifications` table), and nothing is sent after a night has started.

To set up a bot, register a dedicated account on the homeserver, create a room, and invite the participants. The bot needs to be a member of the room. Messages are plain (unencrypted) `m.text` events, so the room must not have encryption turned on.

## Project layout

```
src/server.ts     entry point: config from env, static files (hashed asset URLs), reminder timer
src/app.ts        API: auth middleware, calendar/lineup, rotation planner, nights, participants, settings
src/schedule.ts   date helpers and the rotation cycle
src/db.ts         SQLite schema and migrations (run automatically at startup)
src/auth.ts       Cloudflare Access JWT verification and the name picker
src/tmdb.ts       TMDB search and details
src/jellyfin.ts   Jellyfin library and watched status
src/matrix.ts     Matrix message sender
src/app.test.ts   tests
public/           index.html, app.js, style.css
deploy/           systemd unit
```

## Deployment

Production runs on the home media server (`user@server`) as a systemd service. It's reached at `https://movienight.example.com` through the server's Cloudflare tunnel, with Cloudflare Access in front.

First install:

```sh
rsync -a --exclude node_modules --exclude data --exclude .env --exclude .git ./ user@server:movie-night/
ssh user@server 'cd movie-night && ~/.bun/bin/bun install --production'
# create ~/movie-night/.env on the server (chmod 600; see Configuration)
ssh user@server 'sudo cp movie-night/deploy/movie-night.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now movie-night'
```

Updating:

```sh
rsync -a --exclude node_modules --exclude data --exclude .env --exclude .git ./ user@server:movie-night/
ssh user@server 'cd movie-night && sqlite3 data/movie-night.sqlite ".backup data/backup-$(date +%F).sqlite" && sudo systemctl restart movie-night'
```

- **Data:** never overwrite the server's `data/` directory or its `.env`. The production database and secrets live only there.
- **Migrations:** schema changes run automatically on startup, so take a backup first, as in the update command above.
- **Caching:** the page loads `app.js` and `style.css` with a content hash in their URLs, so browsers and Cloudflare pick up new code on a normal reload.
- **Memory:** the service unit caps memory at 256 MB. The app typically uses about 50 MB.
- **Logs:** `journalctl -u movie-night`.
