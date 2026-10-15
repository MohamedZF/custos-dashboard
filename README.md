# Custos tag dashboards

A password-protected website for Custos Sigfox tags: a homepage with a button for each tag, and a dashboard per tag showing health, message delivery, activity and movement. A GitHub Actions job signs in to Field Signal on a 5-minute schedule, rebuilds the data and republishes the page on GitHub Pages. Nothing runs on your own computer.

```
site/index.html          homepage: one card per tag with its status, links to the tag's dashboard
site/tag.html            a tag's dashboard (tag.html?id=SIGFOX_ID): charts, live OpenStreetMap map
site/compare.html        Compare tab: two to four tags side by side for one feature and time range
site/lock.js, common.css password lock and styles shared by both pages
scripts/update.mjs       signs in to Field Signal, exports each tag's last 31 days, writes encrypted data for the 24 h / 7 day / 30 day views
.github/workflows/       runs the script every 5 minutes (as scheduled) and deploys to GitHub Pages
test/mock-server.mjs     a stand-in Field Signal for testing the script without the real site
```

## Set up (about 5 minutes)

1. **Create a repository** on GitHub, for example `custos-dashboard`, and add these files to it.
   GitHub Pages on a free account needs the repository to be **public**. The secrets below stay private, and the published data is encrypted.
2. **Add two repository secrets.** In the repository: *Settings → Secrets and variables → Actions → New repository secret*.
   - `FIELD_SIGNAL_PASSCODE`: the Field Signal passcode.
   - `SITE_PASSWORD`: a password of your choosing. Viewers type this to open the dashboard.
3. **Turn on Pages.** *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
4. **Run it once.** *Actions → Update dashboard → Run workflow*. When the run finishes (about a minute), the page is live at
   `https://<your-github-username>.github.io/<repository-name>/`.

After that it updates by itself on a 5-minute schedule.

## Good to know

- **Timing.** The workflow is scheduled every 5 minutes, GitHub's shortest interval. GitHub starts scheduled runs on a best-effort basis and delays them at busy times, so updates usually land every 10–45 minutes. The pages check for new data every 5 minutes and turn amber if an update is more than an hour late.
- **Cost.** Free: GitHub Actions on standard runners and GitHub Pages cost nothing for public repositories. Pages has a soft limit of 10 builds an hour, but it does not apply to sites published with a custom Actions workflow like this one.
- **If an update fails** (wrong passcode, Field Signal down), the previous page stays online and GitHub emails you about the failed run. The run log explains the cause in one line.
- **Cloudflare.** Field Signal sits behind Cloudflare. If Cloudflare ever blocks GitHub's servers, the run fails with a message saying so; the Field Signal owner can allow the client in Cloudflare.
- **60-day rule.** GitHub pauses scheduled workflows in public repositories after 60 days without any commits. GitHub emails a warning first; re-enable it with one click under *Actions*, or push any small change.
- **Password.** The script encrypts all data (AES-256-GCM, key from `SITE_PASSWORD` via PBKDF2-SHA256, 600,000 rounds) before publishing, and the page decrypts it in the browser. Without the password, the published files are unreadable; only the page layout is public. Use a long password (four or more random words), because someone who downloads the encrypted file can try passwords offline. "Remember on this device" stores the derived key in the browser until you press **Lock**.
- **Changing the password.** Update the `SITE_PASSWORD` secret and run the workflow. Anyone who ticked "Remember on this device" is asked for the new password.
- **No password.** If `SITE_PASSWORD` is missing, the run fails instead of publishing location data openly.
- **One password for everything.** The same password opens the homepage and every tag. Unlocking once carries over to the other pages in that browser tab; **Lock** forgets it everywhere.
- **Map.** The background map loads live from OpenStreetMap (© OpenStreetMap contributors).

## Add or remove a tag

Edit `TAGS` in `.github/workflows/update.yml`, one tag per line as `SIGFOX_ID=Name shown on the site`:

```yaml
          TAGS: |
            3B4D874=Custos 11.5SAC
            3B4D876=Custos 11-4 SAC
            3A0C108=Custos 11.2BP
            3B4D868=Custos 11.1 SAC
```

Commit the change; the next run adds the tag's card to the homepage. Device IDs are listed on the Field Signal dashboard. A tag with no messages in the past 30 days shows on the homepage as "No messages" with no dashboard link.

## Battery

Battery charts use the raw battery byte from each message payload (byte 10, 0–255), converted the same way Field Signal does: **2.5 V + raw × 1.1 / 255**, so raw 255 = 3.6 V and raw 0 = 2.5 V. This matched the export's 0.1 V battery column on every message checked (6,718 across four tags) and gives steps of about 0.004 V instead of 0.1 V.

## Solar energy balance

Each tag runs on a 400 F hybrid supercap, which the tag charges up to 3.6 V (raw 255), so 3.6 V is full. Stored energy is E = ½CV², counted above 2.5 V (the bottom of the battery scale and the usual lower limit of a hybrid capacitor), so a full supercap holds 1,342 J of usable energy. Net energy is the change in stored energy between messages: solar harvest minus what the tag used. Each dashboard shows stored energy now, net energy over the range and per day, net energy per hour or day, the average energy balance by hour of day (mW), stored energy at every reading, and how often the supercap is full; Compare has the same three charts. While the supercap is full, extra sunlight cannot be stored, so net figures show what the tag kept rather than everything the panel could deliver. Change the capacitor with `CAP_FARADS`, `CAP_VMAX` and `CAP_VMIN` in the workflow's `env:` block.

## GPS quality (time to fix and HDOP)

Each dashboard has a GPS quality section: time to fix (TTF) and HDOP per hour or day, their distributions, and both by hour of day, plus headline tiles and map tooltips. TTF statistics use only messages that got a fix, because the TTF reported on a failed attempt depends on the tag's firmware timeout (64 s on most tags; 11.1 SAC reports 0 or 119 s). HDOP bands: 0–1 excellent, 2–4 good, 5–9 moderate, 10+ poor; 99 means no fix.

## Compare

The **Compare** tab on the homepage shows one tag, or puts up to four side by side. Pick the tags, what to compare (headline figures, received vs missing, delivery %, battery, temperature, GPS fix rate, GPS map, time to fix and HDOP over time / as distributions / by hour of day, activity by hour, daily activity profile) and the time range; the charts appear as soon as one tag and a feature are chosen. Each tag keeps one colour throughout. The choice is kept in the address (`compare.html?tags=3B4D868,3B4D876&f=received&range=7d`), so a comparison can be bookmarked.

## Time ranges

Each dashboard has a **24 hours / 7 days / 30 days** switch. 24 hours shows the 24 whole hours up to now with hourly bars; 7 and 30 days show calendar days (SAST) up to today with daily bars. Every chart, figure, table and the map follow the chosen range, and the choice is remembered in the browser and in the page address (`tag.html?id=…&range=24h`). The homepage cards summarise the past 30 days.

## Other settings

Set these in the workflow's `env:` block:

| Variable | Default | Meaning |
|---|---|---|
| `TAGS` | `3B4D874=Custos 11.5SAC` | Tags to publish, see above |
| `FIELD_SIGNAL_URL` | the Field Signal site | Base URL |

The "What the data shows" notes on each dashboard are worked out from that tag's data at every update (main sites, night-time site use, activity peaks), so they stay correct for any tag.

## Run it on your own machine

```bash
# test against the stand-in server (no passcode needed)
node test/mock-server.mjs &
FIELD_SIGNAL_URL=http://localhost:8787 FIELD_SIGNAL_PASSCODE=test-pass SITE_PASSWORD=test \
  TAGS='3B4D874=Custos 11.5SAC;3B4D876=Custos 11-4 SAC' OUT_DIR=site/data node scripts/update.mjs
python3 -m http.server -d site 8000      # open http://localhost:8000, password: test

# or against the real site
FIELD_SIGNAL_PASSCODE='…' SITE_PASSWORD='…' OUT_DIR=site/data node scripts/update.mjs
```

Needs Node.js 20 or newer.
