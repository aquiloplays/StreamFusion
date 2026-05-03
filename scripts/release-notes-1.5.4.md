## What's new for you

**Auto-updater now actually installs.** When an update is downloaded you get a real **Update Now** button — toolbar pill (top-right), Settings → About → Updates, system tray, and the X-button dialog. One click silently installs and relaunches in ~10 seconds. The old "will apply on close" path quietly broke for users who clicked X expecting an install (the close dialog defaulted to *Minimize to Tray*, so the app stayed alive and the install never fired). That default has been flipped — when an update is pending, the close dialog now defaults to **Install Update vX & Restart**.

**OBS overlays self-heal port collisions.** If something on your machine claimed port 8787 (Hyper-V, WSL2, Docker — they reserve TCP port ranges and a port that worked yesterday can come back unbindable today), SF now automatically falls back to 8788 → 8789 → 8790 → 8791. A yellow banner in *Settings → OBS Overlays* tells you the new port + reminds you to repaste the URLs into your OBS browser sources. Plus a standalone diagnostic script (`scripts/diagnose-obs-server.js`) that probes the ports and tells you what's reserved.

**Raid Finder v4: actually finds streamers.** Two stacked bugs in v3 caused empty results even when SF detected your game. v4 ships smart pagination (scans up to ~2500 streamers, breaks early when sorted past your range), oversamples 4× and sorts by mid-range so results aren't all from the high end, and a server-side game-name → game-ID resolver so the search fires even when only the game *name* is known (decapi.me fallback in the renderer pulls the name when SB doesn't surface it). Range floor for offline / just-live streamers so a 0-viewer percent-mode collapse doesn't yield zero matches. **Re-import the SB actions** (the install modal walks you through it).

**Pop-Out polish:**
- Notifications no longer cover chat — the event toast area now lives in flex flow between feed and input, so subs/gifts/raids push chat *up* instead of overlaying it.
- Profile pictures appear on every pop-out event toast and Events-tab row, with TikTok + YouTube fallbacks via unavatar.io (was Twitch-only before).

**Default chat overlay style is now "Box"** — the unified gradient transcript panel that auto-sizes to your *Max messages on screen* setting. Card and Box (no background) are still selectable in *Settings → OBS Overlays → Chat → Style*.

---

## Technical details

### A. Auto-updater Update-Now path

- New IPCs: `update-downloaded-notify` (renderer → main, signals pending state for tray + close-dialog) and `update-install-failed` (main → renderer, surfaces quitAndInstall throws).
- `_pendingUpdateVersion` tracked in main.js. Drives close-dialog default + tray menu rebuild.
- `install-update` IPC tears down `obs-server.stopServer()`, `discordBot.disconnectBot()`, `patreonAuth.stopRuntimeChecks()`, `discordAuth.stopRuntimeChecks()`, `globalShortcut.unregisterAll()` BEFORE `quitAndInstall(true, true)`. Common silent-NSIS-fail cause on Windows is the SF binary still being held by a writable file lock or socket when the installer tries to overwrite — explicit teardown removes that.
- Tray context menu rebuilt dynamically via `_rebuildTrayMenu()` so the "Install Update Now" entry can appear without restarting the app.
- Close-dialog branches on `_pendingUpdateVersion`: when set, dialog reads `[Install Update vX & Restart] [Minimize to Tray] [Exit Without Updating] [Cancel]` with Install as defaultId. When unset, the original `[Minimize] [Exit] [Cancel]` dialog is preserved.
- Toolbar `#updateAvailBtn` reskinned to "Update Now" on `update-downloaded`, with onclick → `installUpdate()` and a spinner when clicked. Settings → About → Updates surfaces the same button.
- Verbose log lines on every install step (UPDATE: tearing down → quitAndInstall returned → installer should be spawning) so future failures leave a forensic trail.

### B. OBS server port-fallback (`obs-server.js`)

- New `_attemptListen(port)` returns `{ok, code, msg, srv}`. `startServer()` walks a 5-port candidate list `[8787, 8788, 8789, 8790, 8791]` and accepts the first successful bind.
- Retries on **EADDRINUSE** (stale socket from prior SF instance after auto-update) **and EACCES** (Windows reserved-port range).
- `getUrls()` returns `{root, chat, alerts, shoutout, vertical, port, defaultPort}` so the renderer can detect a fallback.
- Settings → OBS Overlays renders a yellow banner when `port !== defaultPort` with the actual URL to copy + an explanation of why it shifted.
- Stopped-server fallback message points users at `netsh interface ipv4 show excludedportrange protocol=tcp` and the new diagnostic script.
- New `scripts/diagnose-obs-server.js` — runnable Node script that probes 8787–8791 (binds + pings each), prints which are free / reserved / in use by SF, and dumps the Windows TCP exclusion ranges. Hands users the answer in 30 seconds.

### C. Raid Finder v4 (`scripts/build-rf-sbae.py` + index.html)

C# action changes:
- Accepts new `gameName` arg. When `gameId` is empty but `gameName` is non-empty, calls `https://api.twitch.tv/helix/games?name=` to resolve. Resolved id+name echoed in the response payload so SF caches them and skips the lookup next time.
- Page cap raised from 3 to 25 (~2500 streamers). Inside-the-loop early-break when `viewer_count < minViewers` (sorted desc, so no later stream can be in range).
- Oversamples to `max(wantCount * 4, 50)` candidates, then sorts by `Math.Abs(viewer_count - mid)` and slices to `wantCount`. v3 sliced before sorting which biased toward the high end of the range.
- Echoes `{scanned, pages, pagesCap, hitCap, inRange}` diagnostic counters in the response payload.
- Action UUIDs bumped to v4 (`a33f0c26-...`, `7fafc95d-...`) so re-import creates fresh actions; `_rfCheckActions` UUID-first match means v4 wins automatically even if a stale v3 lingers in SB.

Renderer changes:
- `_rfDecapiFallback()` fires a third probe alongside `GetBroadcaster` + `TwitchGetChannelInfo`. decapi hits Twitch directly so it knows the current category even when SB hasn't seen a stream-update event.
- `_rfHasGameSignal()` returns true on any of: manual ID override, manual name override, SB-detected ID, SB-detected name, decapi-detected name. Find Targets button enabled on any of those.
- `_rfFindTargets` passes both `gameId` and `gameName` args; range floor expands `[low, high]` to at least `[1, 30]` when high < 30 (offline / just-live streamer).
- `_handleRaidFinderResponse` caches resolved gameId/gameName from the action's echo back into `S.twGameId` / `S.twGame`.
- Empty-state message is diagnostic-aware: distinguishes "scanned X across Y pages, none in range" / "page cap hit, your range is below that" / "no one playing this game right now".

### D. Pop-Out overlay (`overlay.html`)

- `.ov-event-area` removed `position:fixed`; now a `flex-shrink:0` flex item placed in DOM between `.ov-feed` and `.ov-chat-bar`. `:empty { display:none }` collapses to 0px when no events. Body `padding-bottom:108px` reservation removed (no longer needed).
- New `.ov-ev-avatar` (30 px round, 40 px on `.big`) + `.ov-ev-avatar-fb` platform-tinted pico chip. `<img onerror>` swaps to fallback in-place if CDN fails. `.ov-ev-head` is now a centered flex row.
- `sendOverlayEvent(plat, user, text, evMessage, giftHtml, avatar)` takes the URL; `addEvHistory` forwards the same `avSrc` it already resolved for the events panel, so pop-out and panel render the identical pfp.

### E. Events tab avatar fallback (`index.html`)

Extended `addEvHistory`'s avatar resolution from Twitch-only to also use unavatar.io for **TikTok** (`unavatar.io/tiktok/{user}`) and **YouTube** (`unavatar.io/youtube/{user}`) when the username matches a sane regex. Twitch path unchanged. The existing `<img onerror>` still pico-falls-back if the resolver misses.

### F. Default chat-overlay theme (`obs-overlays/chat.html` + `index.html`)

`CFG.theme` and `S.obsCfg.chat.theme` defaults flipped from `'card'` to `'box'`. Settings dropdown re-ordered to put **Box (default)** first. Existing users keep their saved theme via `loadSettings`.

### Files

- `main.js`: tray menu rebuild helper, close-dialog override, install-update teardown sequence, `_pendingUpdateVersion` tracking.
- `preload.js`: `notifyUpdateDownloaded`, `onUpdateInstallFailed` IPCs.
- `index.html`: Update Now toolbar pill, decapi raid-finder fallback, diagnostic empty-state, port-shift banner, default theme = box, settings-side TT/YT avatar fallbacks, response handler caches resolved gameId/gameName.
- `obs-server.js`: port-fallback (EADDRINUSE + EACCES), `getUrls()` exposes `port` + `defaultPort`.
- `obs-overlays/chat.html`: theme = box default.
- `overlay.html`: event-area in flex flow, `.ov-ev-avatar` CSS + img/fb fallback rendering.
- `StreamFusion.html`: marketing thumbnail grid (uses `marketing/screenshots/`).
- `scripts/build-rf-sbae.py`: v4 action with smart pagination + name resolution + diagnostics.
- `scripts/diagnose-obs-server.js`: NEW standalone diagnostic.
- `marketing/`: screenshots + demo loops referenced by landing page.

### Known follow-ups

- Mouse4/Mouse5 hotbar binding Settings UI (IPC wired in `preload.js`, no picker built — flagged in earlier handoffs).
- Cloudflare Worker-vended auto-updater PAT for Tier 3 patrons (so the beta channel doesn't require manual PAT-file management).
- `rotating-bar.html` (untracked, unknown provenance — left in working tree, needs triage).
