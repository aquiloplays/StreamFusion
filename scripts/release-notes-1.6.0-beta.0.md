# StreamFusion 1.6.0-beta.0

## What's new for you

🎨 **Beta merged into the main app — Tier 3 features unlock automatically.** Pre-1.6 there were two separate downloads — the regular StreamFusion and the StreamFusion Beta with the amber icon. From 1.6 there's just one StreamFusion. Sign in with Patreon and:

- **Free / no auth** → standard look, EA-gated features locked.
- **Tier 2 ($6) — "Early Access"** → all current EA features unlocked, default blue/teal theme.
- **Tier 3 ($10) — "Early Access +"** → everything Tier 2 has, plus a **gold + violet theme** + tray icon. Future EA-plus exclusives gate on Tier 3 going forward.

The runtime tray + window icon swaps automatically when you sign in or change tiers — no restart needed.

🧹 **Old beta-install cleanup notice.** If you have the previous `StreamFusion Beta` install on this machine, the merged app shows a one-time notice on first launch with three choices: open the beta uninstaller, dismiss for now (we'll re-prompt next launch), or silence the notice without removing the install. We don't auto-uninstall — you keep control.

---

## Technical details

### Icon palette + runtime swap

`icon-gen.js` adds a new `tier3` palette (gold `#FFD700` + violet-500 `#A755F7` + cream highlight + violet-tinted near-black) and a `tier2` alias for the existing `stable` palette. `scripts/gen-icon.js` (the prebuild hook) now emits `assets/icon-tier3.png` + `assets/icon-tier3.ico` alongside the regular icon — both ship inside the .exe.

`main.js`:

- Module-level `_currentTier` tracks the streamer's current Patreon tier.
- New `_refreshIconForTier()` rebuilds the tray + window icon from `buildSFIcon(256, _sfIconPalette())` and calls `tray.setImage` + `mainWindow.setIcon`. Called from the `patreonAuth.onEntitlementChange` subscription whenever `state.tier` changes.
- `_sfIconPalette()` resolves to `PALETTES.tier3` for Tier 3, `PALETTES.tier2` for Tier 2, with the legacy `beta` palette as a fallback for users still on the old `StreamFusion Beta` install.

### Renderer theme

`applyPatreonState` in `index.html` toggles `body.tier-2` / `body.tier-3` classes from `state.tier`. CSS overrides for `body.tier-3` swap the `--accent` palette (`#3A86FF` → `#FFD700`) and `--accent2` (teal → violet). Tier 2 keeps the existing default — no override needed.

### Legacy beta-install detection

`main.js` adds `maybeShowLegacyBetaNotice()` called from `app.whenReady`. Checks for `%LOCALAPPDATA%\Programs\StreamFusion Beta\` (the per-user NSIS install path the old beta variant used). If present and the marker file `<userData>/legacy-beta-notice-shown.json` is absent, shows a 3-option `dialog.showMessageBoxSync`. Choice 0 launches the beta's uninstaller via `shell.openPath`; choice 2 writes the marker so the notice doesn't re-fire; choice 1 (Dismiss) leaves the marker absent so we re-prompt next launch.

### Build hygiene

The 1.5.5 stable promote ran into a build failure where `electron-builder`'s `files: ["**/*"]` glob bundled `dist-beta/` (15 betas of installers ≈ 1.3 GB) into the stable package, blowing the NSIS intermediate `.7z` to 2.7 GB and crashing on `mmap`. Fixed in `package.json` by adding explicit excludes for `dist-beta/`, `release-worker/`, and the transient script outputs that don't belong in the shipped app. Same fix applies to the merged 1.6.0 build.

### Notes

- Auth regression: 16/16 PASS.
- Phase 2 (per-feature Tier 3 gating beyond aesthetics) is deferred — current Tier 3 unlocks are theme-only. Future "EA +" features will gate on a `S.hasEarlyAccessPlus = S.tier === 'tier3'` derived flag if/when we add them.
- Phase 4 (opt-in pre-release channel for Tier 3 supporters) is also deferred — feature-flagging by tier in a single build is the simpler endpoint and that's what 1.6.0-beta.0 ships.
- The `StreamFusion-Beta` repo will get archived once the migration window is over (probably after 1.6.0 stable ships and existing beta users have had time to switch).
