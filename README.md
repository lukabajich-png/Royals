# Royals Farm System Tracker — hosted, auto-refreshing version

This is the same tracker, restructured so it can live at a real URL and stay
current without anyone having a browser tab open. A small Node script pulls
data from MLB's Stats API and writes it to `data/snapshot.json`. A GitHub
Actions workflow runs that script every 15 minutes and commits the result.
The page itself (`index.html`) just reads that JSON file — it never calls
MLB's API directly from the browser anymore.

## What's in this folder

```
index.html                          the site itself
data/snapshot.json                  generated data (created by the script — not committed yet)
scripts/fetch-data.js               pulls MLB data, writes data/snapshot.json
.github/workflows/update-data.yml   runs the script on a schedule, commits changes
```

## Step 1 — Create the GitHub repo

1. Go to github.com, click **New repository**.
2. Name it whatever you want (e.g. `royals-tracker`). Public is fine — none of
   this involves secrets or API keys.
3. Don't initialize with a README (you already have one here).

## Step 2 — Upload these files

Easiest way if you don't use git day-to-day: on your new repo's page, click
**Add file → Upload files**, then drag in this whole folder's contents,
keeping the folder structure intact (the `.github/workflows/` and `scripts/`
and `data/` folders need to stay nested exactly as they are). Commit directly
to `main`.

If you do use git locally instead:
```
cd royals-tracker-site
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

## Step 3 — Generate the first data snapshot

The page needs `data/snapshot.json` to exist before it'll show anything. You
have two options:

**Option A — let the workflow do it.** Once the repo is pushed, go to the
**Actions** tab on GitHub, click into "Update Royals data" on the left, click
**Run workflow** to trigger it manually the first time (don't wait for the
schedule). It'll fetch the data and commit `data/snapshot.json` for you.

**Option B — generate it locally first**, if you want to see it working
before pushing:
```
node scripts/fetch-data.js
```
This needs Node 18 or newer (for the built-in `fetch`). It writes
`data/snapshot.json`, which you then commit and push along with everything
else.

## Step 4 — Turn on GitHub Pages

1. In your repo, go to **Settings → Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch".
3. Set **Branch** to `main` and folder to `/ (root)`.
4. Save. GitHub gives you a URL like
   `https://YOUR-USERNAME.github.io/YOUR-REPO/` — it takes a minute or two to
   go live the first time.

## Step 5 — Confirm the schedule is running

Go to the **Actions** tab any time after setup — you should see "Update
Royals data" runs appearing roughly every 15 minutes, each one either doing
nothing (if the data hasn't changed) or committing an updated
`data/snapshot.json`. GitHub can delay scheduled runs by a few minutes during
busy periods; that's normal, not a bug.

That's it — the page at your Pages URL now shows data that refreshes itself
in the background, with no browser needing to stay open for it to stay
current.

## Updating things later

- **Prospect rankings drift out of date** (Pipeline republishes their Top 30 /
  Top 100 every few months) — edit the `PROSPECT_RANKS` object near the top
  of `scripts/fetch-data.js`, commit, and the next scheduled run picks it up.
- **Want a different refresh interval** — edit the cron line in
  `.github/workflows/update-data.yml` (`*/15 * * * *` means every 15
  minutes; GitHub's minimum supported interval is every 5 minutes).
- **Something looks broken** — check the Actions tab first; a red X on a run
  means the fetch script hit an error (most likely MLB's API changed
  something), and the log will show exactly where it failed.
