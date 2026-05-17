# StreamFusion session handoff — 2026-05-08

Self-contained dossier for the next session. Covers state, what shipped, what's pending, and what to load first so a cold start can pick up without rediscovering everything.

---

## Load these memory entries first

Just pull the SF cluster:

- `project_streamfusion_audience.md` — streamer-only, no viewer surface
- `reference_streamfusion_build.md` — build & release quirks (auto-updater, signing, NSIS, etc.)
- `project_streamfusion_release_workflow.md` — beta-first workflow, "promote to stable only on explicit go-ahead"
- `reference_streamfusion_infra.md` — Cloudflare Worker, Railway bot service URL, OWNER_EMAILS includes `bisherclay@gmail.com`
- `feedback_secret_rotation.md` — rotate-on-receipt rule (PATs auto-revoke; bot-service secrets do NOT)
- `feedback_powershell_pipe.md` — `gh secret set` must use `--body $value` direct arg, never stdin pipe
- `project_aquilo_widget.md` — Rotation widget at `~/Desktop/aquilo-widget` (Cloudflare Pages auto-deploy)

Memory file `reference_streamfusion_build.md` was UPDATED this session — the old "PAT rotation needed for every release" note was for an obsolete curl-based release flow. We've used `gh release create` for 17 releases this session with zero PAT-paste interaction.

---

## Current state

### Stable channel — `aquiloplays/StreamFusion` (public)

| Version | Released | Notes |
|---|---|---|
| 1.5.4 | pre-session | Pre-existing baseline |
| 1.5.5 | this session | 15-beta arc landed (Rotation integration, ticker overlay, OBS auto-refresh, hotbar hotkeys, Loadout events, etc.) |
| 1.6.0 | this session | The MERGE — single .exe, tier-driven theme + icon (Tier 3 = gold/violet). **Auto-update broken** (latest.yml filename mismatch). |
| 1.6.1 | this session | Hotfix: `nsis.artifactName` so latest.yml + asset filenames match. Auto-update from 1.5.5 / 1.6.0 → 1.6.1 works. |
| 1.6.2 | this session | Hotfix: `getRawAccessTokenAsync` proactively refreshes Patreon token before handing to bot service — fixes `bot_service_rejected — HTTP 403` errors. |
| **1.6.3** | this session | **Current.** Profanity filter for chat overlays — new Settings → OBS Overlays → Chat overlay filter toggle, default off. ~40 common stems → asterisks, main chat panel unaffected. |

### Beta channel — `aquiloplays/StreamFusion-beta` (private)

| Version | Released | Notes |
|---|---|---|
| 1.5.5-beta.0 → beta.14 | this session | The full beta arc. |
| 1.6.0-beta.0 | this session | First merged build; tier theme + legacy-beta-on-disk migration notice. |
| **1.6.0-beta.1** | this session | **Final beta.** `maybeShowBetaVariantMigrationNotice` — points users running FROM the beta install to the stable download. **No further beta releases will ship.** |

### Repositories

- `aquiloplays/StreamFusion` — main + active
- `aquiloplays/StreamFusion-beta` — final beta shipped, **plan: archive in a few weeks** once beta users have migrated
- `aquiloplays/aquilo-widget` (Rotation widget) — separate, Cloudflare Pages auto-deploy, stable

`origin/main` head: **`c70705b`** (1.6.2 hotfix commit).

---

## This session's deliveries (chronological)

### Beta arc (1.5.5-beta.0 → beta.14)

- **Rotation widget integration** (b.0–b.10):
  - Local-loopback bridge between Rotation widget and SF's `/api/integrations/*` surface (new `streamfusion-link.js` in widget; new `obs-server.js` control-stream endpoints in SF).
  - Now-playing card under live-bar with album art, track, artist, live progress, requester chip, play/pause/skip/prev controls (drives Spotify directly).
  - Same controls in pop-out overlay's now-playing strip.
  - User toggle in Settings → Integrations → Rotation Widget.
  - Song activity in events feed + pop-out chat + OBS chat overlay.
  - Spotify branding everywhere (no more purple-TW chip on song requests). Real-requester predicate strips `'anonymous' / 'anon' / 'viewer' / 'someone'` placeholder values.
- **Horizontal ticker overlay** (b.11): new `obs-overlays/ticker.html` with right-to-left chip animation + queue pacing. Settings UI in Settings → OBS Overlays → Horizontal Ticker.
- **OBS browser-source auto-refresh on launch** (b.12–b.13): inline OBS WebSocket v5 client in main.js. Lists browser sources, filters by SF loopback URL match (127.0.0.1:8787-8791), presses `refreshnocache`. Config in Settings → OBS Overlays → Auto-refresh OBS browser sources. Status indicator added in b.14.
- **Per-hotbar-slot keyboard hotkeys** (b.8): `globalShortcut.register` per slot, sync IPC from renderer, capture mode UI. Works with 6+ button mice via mouse-software keyboard mapping (F13–F18 the cleanest pick).
- **Loadout events in events feed** (b.7, b.10, b.14): new `aquilo_loadout_event` broadcast source for outcome events, `_loadoutHandleEvent` handler. Auto-surface every fire as "Action fired" row in events feed; kit-broadcast outcome rows replace auto-rows within 2s of same widgetId.
- **Loadout `stat` widget type** (early b.0): passive readout for Bolts / points / score with optional icon / unit / delta.
- **Test triggers** (b.9, b.10, b.14): Settings → Events → Test Triggers row. Buttons for follow / sub / cheer / raid / TT gift / Kick sub / tip / rotation flavors / Loadout fire / success / failure / ticker chat msg.
- **Chat overlay placement options** (b.2): TT gifts + cross-platform events can land in side columns (left/right of chat box) instead of overlapping. Box-grey theme.
- **Vertical overlay readability + perf** (b.4, b.9): multi-layer text shadow → 3-layer recipe (was 6), dropped infinite gift wobble + halo, `contain: layout paint style` on `.bar`. Gift band moved from top 50vh to band just above chat (`bottom: 110px; height: 40vh`).
- **Pop-out events below chat-send bar** (b.0–b.5), **banners moved out of chat feed area** (b.3): events area max 3 visible; `.ov-banner` from `top: 50%` → `top: 64px`.

### 1.5.5 stable (mid-session)

Aggregated 15-beta arc release on public repo. Auto-update broken on this version due to `latest.yml` filename mismatch — see 1.6.1 below for fix.

### 1.6.0 stable (the merge)

- Single .exe instead of stable + StreamFusion-Beta dual install.
- `icon-gen.js` adds `tier3` palette (gold #FFD700 + violet-500 #A755F7).
- `scripts/gen-icon.js` emits `assets/icon-tier3.png` + `.ico` at prebuild time alongside the regular icon. Both ship inside the .exe.
- `main.js` `_currentTier` + `_refreshIconForTier()` swap tray + window icon at runtime when `patreonAuth.onEntitlementChange` fires with a new tier.
- Renderer `applyPatreonState` toggles `body.tier-2` / `body.tier-3` classes; CSS overrides for `body.tier-3` swap `--accent` → gold and `--accent2` → violet.
- `maybeShowLegacyBetaNotice` — fires for stable users with `%LOCALAPPDATA%\Programs\StreamFusion Beta\` on disk. 3-button dialog (open uninstaller / dismiss / silence).
- `maybeShowBetaVariantMigrationNotice` — fires for users running FROM the beta install (added in beta.1). Points to `https://github.com/aquiloplays/StreamFusion/releases/latest`.

### 1.6.1 stable (auto-updater hotfix)

`package.json` had `portable.artifactName` but not `nsis.artifactName`. NSIS fell back to the default `${productName} Setup ${version}.${ext}` → `StreamFusion Setup 1.6.0.exe` (spaces). But `latest.yml` slugged the URL to `StreamFusion-Setup-1.6.0.exe` (hyphens). Auto-updater 404'd on download. Added explicit `nsis.artifactName: "StreamFusion-Setup-${version}.${ext}"` so on-disk + URL match.

### 1.6.2 stable (shared-bot 403 hotfix)

`shared-bot-connect` IPC was passing `patreonAuth.getRawAccessToken()` (synchronous, returns whatever's on disk) to the bot service. Patreon issues ~30-day access tokens; once stale, Patreon's identity API returns 401. Bot service interprets that as not-entitled and returns 403 to SF. Renderer surfaces "bot_service_rejected".

User has `bisherclay@gmail.com` in `OWNER_EMAILS` — would have hit the owner bypass had the token been accepted. So the failure is upstream of the entitlement decision: stale token rejected by Patreon.

Fix: new `getRawAccessTokenAsync()` in `patreon-auth.js` checks `expires_at`, refreshes via the existing long-lived `refresh_token` if within 60s of expiry, persists the renewed pair. `shared-bot-connect` IPC now awaits the async getter before passing to bot service. Both `/events` SSE + `/associate` guild registration receive the freshened token.

### Build hygiene

`package.json` build.files added explicit excludes for `dist-beta/`, `release-worker/`, `scripts/sbae-decoded.json`, `scripts/sf-rf-import-new.txt`, `scripts/release-notes-*.md`, `scripts/HANDOFF.md` (this file). Pre-fix the `**/*` glob was bundling the `dist-beta/` directory (15 betas of installers ≈ 1.3GB) into the stable package — NSIS `.7z` intermediate hit 2.7GB and crashed `mmap`. Now sub-200MB / build.

---

## Known issues / recovery paths

### Discord post-release-notes Discord post failing on every release

**Status:** still broken at session end. The shared `RELEASE_POST_SECRET` is correctly synced on both repos (verified via direct probe — bot accepts the secret in JSON body). The bot service then tries to post the embed to Discord and gets `HTTP 401: 401: Unauthorized` from Discord's REST API. Root cause: **the bot's Discord token (`BOT_TOKEN` env on Railway) is dead.**

**Fix:** user must rotate the Discord bot token:

1. Discord Developer Portal → SF bot app → Bot tab → **Reset Token** → copy
2. Railway → `streamfusion` service → Variables → `BOT_TOKEN` → paste → save (Railway auto-redeploys)
3. Re-run a failed workflow with `gh run rerun <id> --repo aquiloplays/StreamFusion-beta` — Discord post will fire

The bot's `/health` endpoint reports `gateway: false` and the cached `botUser` info — consistent with "token cached from a successful past login but current session is invalid".

**This is the user's only blocker that came up this session and stayed unresolved.** The release artifacts and auto-updater are unaffected — only the announcement post.

### Raid Finder still failing for the user

The user reported "Find target does not sync game or show targets" mid-session. We shipped diagnostic logging in `1.5.5-beta.6` — the SB action now logs `[SF rf v5]` lines at every step (twitch creds presence, /helix/games resolution, /helix/streams pagination, etc.). User never came back with logs.

**Recovery path:** ask user to re-import the Raid Finder action via Settings → Raid → Re-install (the new action has stable UUIDs sourced from `index.html` so re-import overwrites in place), click Find Targets, paste any `[SF rf v5]` lines from SB's Logs tab.

### User on 1.5.5 stable might have hit the broken auto-update

If the user was on 1.5.5 stable when 1.6.0 dropped, they would have seen "new version detected" but the install never completed (latest.yml filename bug, fixed in 1.6.1). On their next launch, the auto-updater fetches the current `latest.yml` (now points at 1.6.2) and the install will succeed.

If they're stuck and want to skip the wait, they can manually download from the release page — manual install was always fine, only auto-update was broken on 1.6.0.

---

## Pending items (not blockers)

### Phase 2 — Tier-3-only feature gating beyond aesthetics

Current 1.6.x ships aesthetic-only Tier 3 differentiation (gold + violet theme + tray icon). No feature retroactively gated on Tier 3. The plan was to add `S.hasEarlyAccessPlus = S.tier === 'tier3'` and gate specific features once the user has a list. **Open question for the user: which features (theme picker / Loadout dashboard / custom alerts / etc.) should be Tier 3-only.**

### Phase 4 — opt-in pre-release channel for Tier 3

Deferred. The plan was a `latest-experimental.yml` channel that Tier 3 supporters could opt into via Settings. Skipped because tier-flag in a single build is the simpler endpoint. Pick this back up if you want a controlled testing path before merging features into the all-tier build.

### Long-running session token refresh

`1.6.2` only refreshes the Patreon token at `sharedBotConnect` time. If the user's session runs for hours and the access token expires WHILE connected, SSE reconnects use the cached `sharedCfg.accessToken` (now stale) and 403. Workaround: manual disconnect → connect re-runs the IPC. Follow-up: refresh on each `openSse` reconnect attempt.

### Archive `aquiloplays/StreamFusion-beta`

Repo should get archived once existing beta users have had time to migrate via the `1.6.0-beta.1` notice. Probably a few weeks. After archive, the repo's GitHub Actions workflow stops firing — confirm the workflow file is still present so a future un-archive could re-run releases if needed.

---

## Verification checklist

Run before any patreon-auth.js change:

```bash
node scripts/test-patreon-entitlement.js
```

Should report **16/16 PASS**. Latest run (1.6.2 ship): 16/16 PASS.

Quick smoke tests:

- `node --check main.js` — main process syntax
- `node --check obs-server.js`
- `python -c "import html.parser; html.parser.HTMLParser().feed(open('index.html', encoding='utf-8').read()); print('OK')"`

Build:

- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build` — stable
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:beta` — beta

Both should produce sub-200MB `.7z` intermediates after the dist-beta exclude fix.

---

## User context

- **Streamer-only product** — no viewer-facing surface. Don't suggest features for "viewers will see" anything. The pop-out overlay is on the streamer's own desktop.
- **Beta-first workflow** — new code lands on beta channel first. Promote to stable ONLY on explicit go-ahead (`"promote to stable"` / `"finish"` / `"do all of these"` are explicit go-aheads).
- **Communication style** — direct, action-oriented. "Finish everything" / "do whatever you deem best" = full execution authority, but ask if you're about to make architectural changes the user hasn't seen.
- **Token rotation rule** — never echo back tokens / secrets the user pastes. Set them via `gh secret set --body "$value"` (direct arg, NOT pipe — PowerShell appends a trailing newline on stdin which breaks exact-match comparisons downstream). The Railway `RELEASE_POST_SECRET` value the user pasted this session is now synced on both repos — the actual blocker is the BOT_TOKEN.
- **Patreon entitlement** — owner email `bisherclay@gmail.com` bypasses to Tier 3 in both `patreon-auth.js` (client) and `bot-service/index.js` (server) via OWNER_EMAILS allow-list.
- **Single workstation** — the user does all dev on this Windows workstation (not the laptop). `~/Desktop/StreamFusion` for SF, `~/Desktop/aquilo-widget` for Rotation, `~/Desktop/Streamerbot` for SB.
- **`gh` is auth'd as `aquiloplays`** with `repo` scope. Don't ask the user to paste a fresh PAT for releases — the tooling works.

---

## File index for quick orientation

- `main.js` — Electron main, ~2200 lines. Heavy: tier swap, OBS-WS auto-refresh, mouse poller, hotbar hotkeys, OBS server lifecycle, auto-updater wiring, dual migration notices.
- `index.html` — renderer, ~12k lines. Single-file Electron renderer.
- `preload.js` — context bridge.
- `obs-server.js` — local HTTP/SSE server for OBS browser sources, integrations API.
- `obs-overlays/{chat,vertical,ticker,alerts,shoutout}.html` — overlay browser-source pages.
- `patreon-auth.js` — Patreon OAuth + entitlement check + token refresh. Has `getRawAccessToken` (sync) + `getRawAccessTokenAsync` (refreshes if expired).
- `discord-auth.js` — Discord OAuth + Tier 2/3 role check (parallel EA path).
- `discord-bot.js` — both user-bot Gateway client AND shared-bot SSE client.
- `rotation-relay-client.js` — cloud-relay SSE subscriber for rotation events.
- `bot-service/index.js` — Railway-hosted shared bot. Reads `RELEASE_POST_SECRET`, `BOT_TOKEN`, `OWNER_EMAILS`. Endpoints: `/post-release`, `/events` (SSE), `/associate` (guild reg).
- `icon-gen.js` — runtime icon raster + .ico builder. `PALETTES.{stable, beta, tier2, tier3}`.
- `scripts/gen-icon.js` — prebuild hook; emits `assets/icon.{ico,png}` + `assets/icon-tier3.{ico,png}`.
- `scripts/build-beta.js` — beta builder; reads version from package.json, appends `-beta.0` if not already prerelease.
- `scripts/build-rf-sbae.py` — generates the Raid Finder SB import string. Reads SF_RF_*_UUID from index.html for stability.
- `scripts/test-patreon-entitlement.js` — 16-scenario regression guard.
- `scripts/release-notes-*.md` — per-version release notes (git-tracked, build-excluded).
- `scripts/HANDOFF.md` — this file.
- `LOADOUT-KIT.md` — Aquilo Loadout SB kit dev contract. Documents `aquilo_loadout_manifest`, `aquilo_loadout_state`, `aquilo_loadout_event` broadcasts + the `stat` widget type.
- `INTEGRATIONS.md` — Aquilo product integration protocol (`/api/integrations/register|heartbeat|unregister|control-stream` etc.)

---

## Quick start for the next session

1. Run regression test: `node scripts/test-patreon-entitlement.js` — confirm 16/16.
2. `git log --oneline origin/main..main` — confirm clean (should be empty if last session pushed everything; this session ended at `c70705b` pushed).
3. Check Railway BOT_TOKEN status — if user reports Discord posts still failing, that's the unresolved blocker.
4. If user resumes Raid Finder debugging, ask for `[SF rf v5]` lines from SB Logs.
5. Phase 2 / Phase 4 only on user request.

Auth regression: 16/16 PASS.
