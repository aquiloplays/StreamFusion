# Releasing StreamFusion

How to ship a new StreamFusion build so every installed copy auto-updates to it.

There are two release paths — the **CI path** is recommended (one command on your laptop, GitHub does the build). The **local-build path** is the backup if Actions is down.

---

## How auto-update works (end-user side)

Every StreamFusion install hits `aquiloplays/streamfusion-downloads` on launch and again every 4 hours (via `electron-updater`'s default poll). It downloads `latest.yml`, compares the version to what's running, and if newer it:

1. Downloads the `.exe` in the background (delta-only thanks to `.blockmap`).
2. Fires `update-downloaded` — the renderer surfaces a non-blocking "Install Update v1.X.Y" indicator, the tray menu grows an "Install Update Now" item, and the close-dialog default flips from "Minimise to Tray" to "Install & Restart".
3. On next app quit, NSIS runs silently (`/S`) and re-launches the new version. No prompt, no installer UI.

You don't need to do anything on the client side. As long as the release is **published** (not draft) on `aquiloplays/streamfusion-downloads` and the asset URLs match `latest.yml`, every running install picks it up automatically.

---

## CI path (recommended)

### One-time setup

1. **Create a fine-grained PAT** at https://github.com/settings/personal-access-tokens with:
   - Resource owner: `aquiloplays`
   - Repository access: `streamfusion-downloads` (just that one)
   - Permissions: **Contents: Read and write**
   - Expiration: pick something durable — 1 year is fine
2. Copy the token, then on `aquiloplays/StreamFusion` go to **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `STREAMFUSION_DOWNLOADS_TOKEN`
   - Value: paste the PAT
3. Done. The workflow in `.github/workflows/release.yml` uses it as `GH_TOKEN` for `electron-builder --publish always`.

### Cutting a release

```bash
# 1. Bump the version in package.json (e.g. 1.7.0 → 1.8.0). Commit it.
git commit -am "1.8.0: <short summary>"

# 2. Tag the commit with v + that exact version and push both.
git tag v1.8.0
git push origin main --follow-tags
```

The push triggers `.github/workflows/release.yml`. It checks out the tag, verifies `package.json` matches, runs `npm ci`, then runs `npx electron-builder --win --publish always`. ~10 minutes later there's a **draft** release on `streamfusion-downloads` with:

- `StreamFusion-Setup-1.8.0.exe`
- `StreamFusion-Setup-1.8.0.exe.blockmap`
- `StreamFusion-Portable-1.8.0.exe`
- `latest.yml`

### Publishing the release (the actual "ship it" step)

1. Open the draft on https://github.com/aquiloplays/streamfusion-downloads/releases.
2. Paste the body from `scripts/release-notes-<version>.md` if you wrote one.
3. Click **Publish release**.

The moment the release flips from draft → published, every running StreamFusion install (anyone who launches in the next 4 hours) will pick it up and silently update on next quit.

### If something goes wrong

- **Workflow failed at "Resolve tag + version"** → you tagged but forgot to bump `package.json`. Delete the tag (`git tag -d v1.8.0 && git push --delete origin v1.8.0`), bump, recommit, retag.
- **Workflow failed at "Build + publish"** → check the logs. `electron-builder` errors are usually about the token (PAT expired? Wrong scope?) or about a stale `node_modules` (delete the npm cache on the runner — actually the workflow uses `npm ci` so that shouldn't happen).
- **Asset uploaded but `latest.yml` is missing** → that's the bug we hit on 1.6.0. `nsis.artifactName` in `package.json` must be `StreamFusion-Setup-${version}.${ext}` (hyphens, no spaces) so the on-disk filename matches the URL `latest.yml` generates. Already fixed.

---

## Local-build path (backup)

If Actions is down or you need to ship from your dev box:

```powershell
# Ensure the GH_TOKEN env var is set to the same PAT that the workflow uses.
$env:GH_TOKEN = "<paste-PAT>"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

# Bump version in package.json first, then:
npm ci
npm run release
```

`npm run release` is `electron-builder --win --publish always` — same end result as the workflow, just running on your local machine instead of a GitHub runner. It publishes to whichever `publish` target is set in `package.json` (`aquiloplays/streamfusion-downloads`).

Same draft → published flip applies after.

---

## What you DON'T have to do

- **No code-signing setup.** `package.json` `build.win.sign: null` is explicit. Users see SmartScreen on first install but auto-updates after that are seamless. If you ever want to remove SmartScreen, buy an OV/EV code-signing certificate, set `CSC_LINK` + `CSC_KEY_PASSWORD` in repo secrets, and remove `sign: null`. The auto-update flow is unaffected by signing — only the first install experience.
- **No version pinning in clients.** The auto-updater compares against `latest.yml`'s `version` field, which `electron-builder` writes from `package.json`. As long as those match, the flow works regardless of what version each client is on (1.5.x clients update to 1.8.0 just fine — `electron-updater` doesn't care about hop distance).
- **No release-notes-to-Discord plumbing.** `post-release-notes.yml` lives on the `StreamFusion` repo and fires on its own published releases, but the actual releases live on `streamfusion-downloads`. If you want Discord posts to fire automatically, duplicate `post-release-notes.yml` onto `streamfusion-downloads` (and copy the `SF_RELEASE_POST_SECRET` + `SF_RELEASE_CHANNEL_ID` repo secrets across). Manual workaround in the meantime: from the Actions tab on `StreamFusion`, **Run workflow** → enter the tag and it'll post.
