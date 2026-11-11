# Movie Night

Weekly movie night planner. Participants rotate roles: the **proposer** picks 3 movies, and the **chooser** picks which one gets watched. Movie nights recur on one or more days of the week, each with its own start time (Settings), and any single night can be moved or retimed. The rotation advances one step per night. It follows a fixed cycle of n×(n−1) nights for n people, in which every proposer/chooser pairing happens once. Each round of n nights has everyone proposing once and choosing once, and nobody gets the same role on consecutive nights. Nights with locked roles (proposals made, or set by an admin) keep them. The open nights between them are planned as a whole, so there are as few back-to-back repeats as possible, with ties going to the natural cycle order. A night that passes without proposals carries its turn over to the next night.

Built with Bun, Hono and `bun:sqlite`, using TMDB for search, posters and movie details. There is no build step.

## Run locally

```sh
bun install
cp .env.example .env     # set TMDB_TOKEN
bun run dev              # http://localhost:8795
bun test
```

You need a free TMDB account for `TMDB_TOKEN`. Go to Settings → API on themoviedb.org and use the "API Read Access Token" (a v3 API key also works).

## Identity

- **Through the tunnel** (e.g. `https://movienight.example.com`): Cloudflare Access handles Google login. The server verifies the `Cf-Access-Jwt-Assertion` JWT against `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and matches the email to a participant. Emails in `ADMIN_EMAILS` are added as admins on their first visit. Any request carrying Cloudflare headers must have a valid token, and these requests are refused until Access is configured.
- **Without the tunnel**, there's a "who's watching?" picker that stores a cookie with no real authentication. By default (`PICKER=localhost`) only requests from the machine itself can use it, which covers local development. Other devices on the LAN are sent to `PUBLIC_URL` to sign in with Google, so nobody can impersonate another participant. `PICKER=lan` opens the picker to the whole network (honor system) and `PICKER=off` disables it. On first run with no participants, the picker asks you to create the first (admin) participant. On the server, `ADMIN_EMAILS` bootstraps the admin instead.

Admins manage participants (add by Google email, reorder the rotation, remove, make admin), the night (weekday, time, timezone, rating region) and per-night role overrides from **Settings** and **Edit roles**.

## Rules

- **Calendar and lineup.** The calendar is the weekly schedule (Settings) plus one-off changes: a skipped date, an extra date or a custom start time. The lineup is the ordered queue of nights that have roles, proposals or a pick. Lineup nights fill the calendar's upcoming dates in order, so adding or removing weekdays, skipping a date or moving a night never leaves a gap; the nights just slide onto the next dates. When a date passes, the night on it is recorded as held then.
- **Roles.** Nights after the lineup are planned from the rotation: everyone proposes and chooses once per round, nobody gets the same role on consecutive nights, and pairings vary. Proposing for a later open night adds the open nights before it to the lineup with the roles they were showing, so nothing shifts. A night that passes with nothing proposed carries its turn over to the next night.
- **Proposing and picking.** The proposer sets or changes the 3 choices until a movie is picked. The chooser picks, switches or undoes until the night has passed. Admins can do either at any time with **Admin override**, and can set a night's roles.
- **Changing dates (admins).** **Change date** moves a night with its roles, choices and pick, and the nights after it close up behind it. **Back to regular schedule** undoes a move or a custom time. **Skip this date** cancels a date and moves the nights after it up; skipped dates appear in the list with **Restore**. A past night's date can be corrected the same way.

## Deploy to the media server

```sh
rsync -a --exclude node_modules --exclude data --exclude .env ./ user@server:movie-night/
ssh user@server 'cd movie-night && ~/.bun/bin/bun install --production'
# create ~/movie-night/.env on the server (see .env.example)
ssh user@server 'sudo cp movie-night/deploy/movie-night.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now movie-night'
```

Tunnel: add this ingress rule to `/etc/cloudflared/config.yml` above the `http_status:404` catch-all, then run `cloudflared tunnel route dns <tunnel> movienight.example.com` and `sudo systemctl restart cloudflared`:

```yaml
  - hostname: movienight.example.com
    service: http://localhost:8795
```

Cloudflare Access (Zero Trust dashboard):

1. Settings → Authentication: add **Google** as a login method.
2. Access → Applications → Add → Self-hosted, domain `movienight.example.com`. Add a policy that allows the participants' emails (or "Everyone" with Google, since the app enforces its own participant list).
3. Copy the application's **AUD tag** into `ACCESS_AUD`, and set `ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`. Then run `sudo systemctl restart movie-night`.
