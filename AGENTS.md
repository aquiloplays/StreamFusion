# StreamFusion — project guide

Windows-first Electron desktop app for streamers, built by aquiloGG (Clay): a unified multi-platform chat viewer for Twitch, YouTube, TikTok, and Kick, plus events panel, OBS browser-source overlays, raid finder, Discord integration, and a thermal receipt printer. It gets Twitch/YouTube chat via **Streamer.bot** and TikTok via **Tikfinity** (both local WebSocket bridges — see `SETUP.md`) rather than holding platform credentials itself. Streamer-facing only — viewers never run this app. Every feature is free: the old Patreon/Discord entitlement gating was retired (2026-06); don't resurrect it.

The stable channel lives in this repo (`aquiloplays/streamfusion`); binaries are published to `aquiloplays/streamfusion-downloads`; a separate private repo `aquiloplays/streamfusion-beta` is the pre-release channel.

## Stack & releases

- Electron 29 + plain HTML/JS. No bundler, no framework, no transpile step: the whole renderer UI is one large `index.html` (~1.2 MB), runtime deps are just `electron-updater` and `ws`.
- Three **Cloudflare Workers** are embedded in the repo but deployed separately via wrangler (never by CI): `patreon-proxy.worker.js` + root `wrangler.toml` (the `aquilo-auth-proxy` OAuth broker at auth.aquilo.gg — the "patreon" filename is historical, Patreon support was removed), `favorites-worker/` (favorites.aquilo.gg, KV sync for stream-info presets), `release-worker/` (`/post-release` → Discord embed). Worker secrets are set via `wrangler secret put`/dashboard; `[vars]` in wrangler.toml are public identifiers only.
- **Releases are tag-driven** (`RELEASING.md` is the authority): bump `package.json` version, tag `v<version>`, push — `.github/workflows/release.yml` (windows-latest) runs electron-builder and uploads a **draft** release to `streamfusion-downloads`; publishing the draft is the manual "ship it" step. Installed copies auto-update via electron-updater polling `latest.yml`. Builds are deliberately unsigned (`build.win.sign: null`).
- `.github/workflows/post-release-notes.yml` fires on this repo's published releases (or manual dispatch with a tag) and posts release notes to Discord via the release worker. `.github/workflows/ci.yml` runs the syntax gate on pull requests.

## Commands

- `npm install` / `npm ci` — set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` when you don't need to launch the app (CI and Claude Code web sessions do; the ~100 MB Electron binary is only needed for `npm start`)
- `npm run check` — `node --check` over every first-party JS file (`scripts/check-syntax.mjs`); run before pushing — it's the only CI gate. Needs Node ≥ 22 (module-syntax auto-detection: the workers are ESM in `.js` files).
- `npm start` — launch the app (`electron .`); needs the real Electron binary and a display, so not runnable in headless containers
- `npm run gen-icon` — regenerate `assets/icon.*` from `icon-gen.js` (also wired as `prebuild`)
- `npm run build` / `build:portable` / `release` — electron-builder; the `build*` scripts use Windows `set` syntax and are for Clay's dev box. Don't run release builds from sessions — use the tag-driven CI path in `RELEASING.md`.

## Layout

- `main.js` — Electron main process (~3k lines): windows, tray, IPC, auto-updater, and wiring for all the modules below
- `index.html` — the entire renderer UI in one file; `preload.js` — the `contextBridge` API between renderer and main; `overlay.html` — pop-out chat window
- `obs-server.js` — localhost-only HTTP + SSE server (default port 8787) that serves the OBS browser-source overlays and the `/api/integrations/*` companion-product protocol (`INTEGRATIONS.md`)
- `discord-bot.js` (outbound webhooks + inbound Gateway bot), `warden-agent.js` (Warden on-machine agent: chat relay + mod-triggered OBS commands), `printer.js` + `printer-render.html` (ESC/POS receipt printer engine), `browser-auth.js` / `twitch-auth.js` (OAuth via the auth.aquilo.gg broker; secrets never ship in the binary), `rotation-relay-client.js` (Rotation widget relay), `icon-gen.js` (single source of truth for every icon surface)
- `StreamFusion.html`, `banner.html`, `promo*.html`, `rotating-bar.html`, `marketing/` — static marketing/promo assets, not app code
- `scripts/` — `gen-icon.js`, `post-release-notes.js`, `check-syntax.mjs` (CI gate), puppeteer `*-shot.mjs` screenshot helpers, `test-auth-suite.js` (manual harness, not CI), an archive of `release-notes-*.md`, and `HANDOFF.md` (a historical session dossier — don't treat it as current state)
- Docs: `SETUP.md` (end-user guide), `RELEASING.md` (read before touching `release.yml` or `package.json` `build` config), `INTEGRATIONS.md` (obs-server integration contract — additive-only), `DISCORD-RICH-PRESENCE.md` (plan only, NOT built)

## Conventions & gotchas

- There are no tests and no linter; `npm run check` (syntax) is the only automated gate. If you add a new routine verify command, add it to `.github/workflows/ci.yml` and the `.claude/settings.json` allowlist too.
- `package.json` `version` MUST match the release tag with the `v` stripped — `release.yml` fails fast if they diverge.
- `nsis.artifactName` must stay `StreamFusion-Setup-${version}.${ext}` (hyphens, no spaces) — changing it breaks auto-update by desyncing `latest.yml` URLs from asset filenames (this shipped broken in 1.6.0).
- `build.files` in `package.json` is the packaging allowlist: new top-level dev/infra files (workers, docs, CI) must be added to its `!` exclusions or they ship inside the installer.
- `obs-server.js` binds 127.0.0.1 only and is deliberately auth-free and CORS-open (`*`) so OBS browser sources and hosted widgets can reach it — keep it that way, and treat the `/api/integrations` contract as additive-only (never remove/repurpose fields).
- Never commit secrets. Worker secrets (`TWITCH_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, …) live on the workers; release tokens (`STREAMFUSION_DOWNLOADS_TOKEN`, `SF_RELEASE_POST_SECRET`) live in repo/Actions secrets.

## Claude Code sessions

`.claude/hooks/session-start.sh` installs npm dependencies (with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — web containers can't fetch the Electron binary and sessions don't need it) when a web session starts, and `.claude/settings.json` pre-approves the routine verify commands above.
