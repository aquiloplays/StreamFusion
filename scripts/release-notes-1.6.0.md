# StreamFusion 1.6.0

The big architectural change: **one app, one download**. The old `StreamFusion Beta` separate-install variant has been merged into the main app. Patreon tier now picks the runtime theme + icon — no more "which version do I download" question.

## What's new for you

🎨 **One app, theme by Patreon tier.** Sign in with Patreon and:

- **Free / no auth** → standard look, EA-gated features locked.
- **Tier 2 ($6) — "Early Access"** → all current EA features unlocked, default blue/teal theme.
- **Tier 3 ($10) — "Early Access +"** → everything Tier 2 has, plus a **gold + violet theme** + tray icon. Future EA-plus exclusives gate on Tier 3 going forward.

The runtime tray + window icon swaps automatically when you sign in or change tiers — no restart needed.

🧹 **Migration notices for old beta-install users.** If you have the previous `StreamFusion Beta` install on this machine, the merged app surfaces a one-time notice on first launch with three choices: open the beta uninstaller, dismiss for now, or silence the notice. Never auto-uninstalls — you keep control.

---

## Everything from the 1.5.5 stable release

If you're updating from 1.5.4 or earlier, you also get:

- **Rotation widget integration**: now-playing card with album art / requester chip / Spotify controls (play / pause / skip / previous), song activity in events / pop-out / OBS overlays, full Spotify-green branding (no more Twitch-purple "TW" chip on song requests). Toggle in **Settings → Integrations → Rotation Widget**.
- **New Horizontal Ticker overlay**: chat messages slide right-to-left across a thin strip. Drop on top or bottom of your scene as a band. Recommended OBS browser source size 1920×60.
- **OBS browser sources auto-refresh on SF launch** via the OBS WebSocket plugin — no more manually right-clicking each source after auto-update.
- **Per-hotbar-slot keyboard hotkeys** with capture mode — works with 6+ button mice via mouse-software keyboard mapping (F13–F18 are great picks).
- **Loadout SB-kit activity in the events feed** — every widget click auto-surfaces; kit-broadcast outcome events replace auto-rows within 2s. New `stat` widget type for Bolts / point-style readouts.
- **Side-column gift / event placement** on the horizontal chat overlay, **new "Box (grey)" theme**.
- **Vertical overlay readability + perf fix** (3-layer text-shadow, dropped infinite gift wobble/halo, contain: paint).
- **Pop-out events below the chat-send bar**; banners moved out of the chat feed area.
- **Test triggers** in Settings → Events for every event type (incl. Loadout fired/success/failure + ticker chat msg).
- **Diagnostic logging** on the Raid Finder SB action (`[SF rf v5]` lines in SB Logs).

Full per-beta release notes: see `scripts/release-notes-1.5.5-beta.{0..14}.md` and `scripts/release-notes-1.6.0-beta.0.md`.

---

## Technical details

### Tier-driven theme + icon swap

`icon-gen.js` adds `tier3` palette (gold `#FFD700` + violet-500 `#A755F7` + cream highlight + violet-tinted near-black). `scripts/gen-icon.js` (the prebuild hook) emits `assets/icon-tier3.png` + `assets/icon-tier3.ico` alongside the regular icon — both ship inside the .exe.

`main.js`:

- `_currentTier` tracks the streamer's current Patreon tier.
- `_refreshIconForTier()` rebuilds the tray + window icon from `buildSFIcon(256, _sfIconPalette())` and calls `tray.setImage` + `mainWindow.setIcon`. Wired into the `patreonAuth.onEntitlementChange` subscription whenever `state.tier` changes.

Renderer: `applyPatreonState` toggles `body.tier-2` / `body.tier-3` classes from `state.tier`. CSS overrides for `body.tier-3` swap `--accent` (`#3A86FF` → `#FFD700`) and `--accent2` (teal → violet). Tier 2 keeps the default — no override needed.

### Migration helpers

Two notices, both gated by per-user marker files in `<userData>` so they don't re-fire after dismissal:

1. **`maybeShowLegacyBetaNotice`** — fires when a stable run detects `%LOCALAPPDATA%\Programs\StreamFusion Beta\` on disk. Three buttons: open the beta uninstaller / dismiss / silence.
2. **`maybeShowBetaVariantMigrationNotice`** — fires when the running app IS the beta variant (`_isBetaVariant()` true). Points to `https://github.com/aquiloplays/StreamFusion/releases/latest` for the migration download.

### Build hygiene

`package.json` build.files gained explicit excludes for `dist-beta/`, `release-worker/`, `scripts/sbae-decoded.json`, `scripts/sf-rf-import-new.txt`, `scripts/release-notes-*.md`, `scripts/HANDOFF.md`. Pre-1.5.5 the `**/*` glob was bundling these into the package — fifteen betas of installers brought the NSIS intermediate `.7z` to 2.7GB and crashed `mmap` on Windows. Now sub-200MB / build, mmap fits.

### Auth regression

16/16 PASS across the entire 1.5.5-beta.0 → 1.6.0 arc.

### Notes

- **Phase 2** (Tier-3-only feature gating beyond aesthetics) is deferred. Current 1.6.0 ships aesthetic-only differentiation — no retroactive gating of any existing EA features. We'll wire `S.hasEarlyAccessPlus = S.tier === 'tier3'` if/when there's a feature worth gating.
- **Phase 4** (opt-in pre-release channel for Tier 3 supporters) is also deferred. The single-build tier-flag model is the simpler endpoint and that's what 1.6.0 ships.
- The `aquiloplays/StreamFusion-beta` repo will get archived once existing beta users have had time to migrate (probably a few weeks).
