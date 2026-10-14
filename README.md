# Custos 11.5SAC dashboard

A password-protected web page showing the health, message delivery and movement of Sigfox tag **Custos 11.5SAC (3B4D874)**. A GitHub Actions job signs in to Field Signal every 10 minutes, rebuilds the data and republishes the page on GitHub Pages. Nothing runs on your own computer.

```
site/index.html          the page (charts, live OpenStreetMap map, reloads its data every 10 min)
scripts/update.mjs       signs in to Field Signal, exports the tag's last 35 days, writes site data
.github/workflows/       runs the script every 10 minutes and deploys to GitHub Pages
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

After that it updates by itself every 10 minutes.

## Good to know

- **Timing.** GitHub starts scheduled runs on a best-effort basis, so updates usually land every 10–15 minutes and occasionally later at busy times. The page shows how old its data is and turns amber if an update is more than 40 minutes late.
- **If an update fails** (wrong passcode, Field Signal down), the previous page stays online and GitHub emails you about the failed run. The run log explains the cause in one line.
- **Cloudflare.** Field Signal sits behind Cloudflare. If Cloudflare ever blocks GitHub's servers, the run fails with a message saying so; the Field Signal owner can allow the client in Cloudflare.
- **60-day rule.** GitHub pauses scheduled workflows in public repositories after 60 days without any commits. GitHub emails a warning first; re-enable it with one click under *Actions*, or push any small change.
- **Password.** The script encrypts all data (AES-256-GCM, key from `SITE_PASSWORD` via PBKDF2-SHA256, 600,000 rounds) before publishing, and the page decrypts it in the browser. Without the password, the published files are unreadable; only the page layout is public. Use a long password (four or more random words), because someone who downloads the encrypted file can try passwords offline. "Remember on this device" stores the derived key in the browser until you press **Lock**.
- **Changing the password.** Update the `SITE_PASSWORD` secret and run the workflow. Anyone who ticked "Remember on this device" is asked for the new password.
- **No password.** If `SITE_PASSWORD` is missing, the run fails instead of publishing location data openly. To publish without a password on purpose, set `ALLOW_PUBLIC: '1'` in the workflow's `env:` block.
- **Map.** The background map loads live from OpenStreetMap (© OpenStreetMap contributors).

## Change the tag or the time range

Set these in the workflow's `env:` block:

| Variable | Default | Meaning |
|---|---|---|
| `DEVICE_ID` | `3B4D874` | Sigfox device ID |
| `DEVICE_NAME` | `Custos 11.5SAC` | Name shown in the data |
| `DAYS` | `35` | How many days of history to include |
| `FIELD_SIGNAL_URL` | the Field Signal site | Base URL |
| `ALLOW_PUBLIC` | unset | `1` publishes unencrypted data when no `SITE_PASSWORD` is set |

The page's heading and interpretation notes are written for 11.5SAC; edit `site/index.html` if you point it at another tag.

## Run it on your own machine

```bash
# test against the stand-in server (no passcode needed)
node test/mock-server.mjs &
FIELD_SIGNAL_URL=http://localhost:8787 FIELD_SIGNAL_PASSCODE=test-pass SITE_PASSWORD=test OUT_DIR=site/data node scripts/update.mjs
python3 -m http.server -d site 8000      # open http://localhost:8000, password: test

# or against the real site
FIELD_SIGNAL_PASSCODE='…' SITE_PASSWORD='…' OUT_DIR=site/data node scripts/update.mjs
```

Needs Node.js 20 or newer.
