## What's new for you (beta)

Same feature set as stable v1.5.4 — beta channel is in sync. The big-three user-facing fixes:

**Auto-updater now actually installs.** Real **Update Now** button (toolbar pill, Settings → About → Updates, system tray, X-button dialog default). One click silently installs and relaunches in ~10 seconds. The previous "will apply on close" path quietly broke for users whose close-dialog default was *Minimize to Tray* — that default now flips to **Install Update vX & Restart** when an update is pending.

**OBS overlays self-heal port collisions.** SF now falls back from 8787 to 8788 → 8791 if the default port is reserved by Hyper-V / WSL2 / Docker. Yellow banner in *Settings → OBS Overlays* tells you the new port + reminds you to repaste the URLs. Plus `scripts/diagnose-obs-server.js` for self-diagnosis.

**Raid Finder v4: actually finds streamers.** Smart pagination (scans up to ~2500 streamers, breaks early when sorted past your range), oversamples 4× then sorts by mid-range, server-side game-name → game-ID resolution, decapi.me fallback when SB doesn't surface the game, and a range floor for offline / just-live streamers. **Re-import the SB actions** (the install modal walks you through it).

**Pop-Out polish:** events no longer cover chat (flex-flow now), profile pictures appear on every pop-out toast and Events-tab row (TikTok + YouTube fallback via unavatar.io), default chat overlay theme is now **Box (gradient)**.

---

## Technical details (beta)

Identical to v1.5.4 stable — see https://github.com/aquiloplays/StreamFusion/releases/tag/v1.5.4 for the full technical writeup. No beta-only feature flags this round; beta installs get the same code stable does, with the amber/orange icon and BETA branding.

### Beta channel notes

- Updater PAT is still expected at `%APPDATA%\streamfusion-beta\beta-updater-token.txt`. Tier 3 patrons who already have one stay updated automatically.
- Worker-vended PAT for Tier 3 patrons is still pending (so the manual file isn't required) — flagged as an open follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
