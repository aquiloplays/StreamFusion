# StreamFusion 1.5.5-beta.1

## What's new for you

🎵 **Now-Playing bar with Spotify controls.** A compact card under the Live bar shows your current song's cover art, title, artist, and a live progress bar — plus play/pause/skip/previous buttons that drive Spotify directly. Surfaces automatically when your Aquilo Rotation widget is running on the same machine.

🎧 **Song requests in your pop-out chat overlay.** Whenever a viewer requests, queues, plays, or skips a track via Rotation, it now also shows up inline with chat in your second-monitor pop-out — not just in the events history.

⚡ **Bolts-ready Loadout dashboard.** The Aquilo Loadout schema gained a new `stat` widget type for passive readouts (Bolts, points, score). Once your kit publishes Bolts, the value + ±delta chip will render right in your Loadout panel.

---

## Technical details

### Companion-product control protocol

`obs-server.js` gains two new endpoints on the `/api/integrations/*` surface:

- **`POST /api/integrations/control`** — body `{ clientId, command, args? }`. Sends a directive to a connected product's control SSE stream. Returns `{ ok, reason? }` so the renderer can disable buttons + surface a "widget offline" hint when no stream is open.
- **`GET /api/integrations/control-stream?clientId=X`** — SSE channel a companion product holds open after register. SF writes commands here via `pushControl(clientId, command, args)`. New connections from the same clientId displace the previous stream cleanly (handles widget reload without zombie streams).

`pushControl` is exported from the module and wired through `ipcMain.handle('obs-integration-control', ...)` so the renderer drives it via `electronAPI.obsControlIntegration(clientId, command)`. `obsIntegrationList()` is also exposed so the now-playing card can find a registered `aquilo-spotify-widget` and read its meta + clientId.

### Now-playing bar

New `.np-bar` element under `.live-bar`. Two data sources flow into a shared `_npState`:

1. **Integration heartbeat meta** — preferred when the streamer's Rotation widget is on the same machine and reaches the local loopback. Carries `track / artist / albumArt / isPlaying / progressMs / durationMs / updatedAt`. Controls work.
2. **`rotation.song.playing` cloud-relay events** — flips the bar instantly on track change, AND keeps the bar populated when the streamer's widget is hosted on `widget.aquilo.gg` and can't reach 127.0.0.1 (mixed-content block in hardened browsers). Controls disabled in that case.

A 800ms ticker advances the progress fill smoothly between updates by interpolating `progressMs + (Date.now() - updatedAt)` against `durationMs`. Stops cleanly when paused or idle.

### Pop-out overlay chat mirroring

The existing `onRotationEvent` handler now also calls `sendOverlayChat({...})` for each kind, mirroring song activity into the pop-out's chat feed alongside the existing events-history + OBS browser-source paths. Tagged with Spotify green so it visually reads as music activity.

### Loadout `stat` widget

`LOADOUT-KIT.md` gets a schema entry for `type: 'stat'`. Passive readout — kit owns the value, SF never mutates. Optional `icon`, `unit`, `delta` fields; delta renders a small green/red chip below the value when non-zero. `_loadoutRenderWidgetHtml` adds the rendering branch; `_loadoutRefreshWidget` patches value + delta in place from `aquilo_loadout_state` deltas without re-rendering the whole panel.

### Companion side (Rotation widget, separately deployed)

The Aquilo Rotation widget got a new `streamfusion-link.js` module that probes `127.0.0.1:8787-8791` for a running SF, registers as `aquilo-spotify-widget` with capabilities `now-playing` / `song-changed` / `request-skip` / `playback-control`, heartbeats track meta every 15s, and opens the SSE control-stream so SF can drive playback. Independent of the existing cloud-relay event flow — that path is untouched.

### Notes

- Auth regression guard: 16/16 PASS.
- Additive-only protocol changes; older companion products (or older SF) keep working.
- No behavioral change for streamers who don't run Rotation — the bar stays hidden, the dashboard `stat` widget never renders, controls IPC is dormant.
