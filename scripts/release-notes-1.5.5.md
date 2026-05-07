# StreamFusion 1.5.5

A big stable release — fifteen betas of work landing for everyone at once. Highlights:

## What's new for you

### 🎵 Rotation widget integration

If you run [the Rotation song-request widget](https://widget.aquilo.gg) on the same machine as StreamFusion, SF now has deep integration with it:

- **Now-playing bar** under the live indicator with album art, track, artist, live progress, requester chip (`@username`), and play / pause / skip / previous transport buttons. Drives Spotify directly via the widget.
- **Spotify controls in the pop-out** so you can pause / skip from your second monitor without alt-tabbing.
- **Song activity in the events feed and pop-out chat** with Spotify-green branding (no more Twitch-purple "TW" badge on song requests).
- **Rotation events tab** rows show requester names properly — empty/anonymous placeholder values no longer surface as "@anonymous".
- **Toggle** in **Settings → Integrations → Rotation Widget** to hide the now-playing bar entirely.

### 📺 New Horizontal Ticker overlay

A fourth chat-overlay variant alongside the existing card / box / vertical layouts. Drop on top or bottom of your scene as a band — chat messages slide right-to-left across the strip with platform icons, avatars, and emotes. Recommended OBS browser-source size **1920×60**.

Find it in **Settings → OBS Overlays → Horizontal Ticker**. Tunable: font size, bar height, scroll duration, opacity, position (top / bottom), max queue depth.

### 🪟 OBS browser sources auto-refresh on SF launch

When SF auto-updates (or you start it after OBS is already running), browser sources pointing at SF would sit on a "this site can't be reached" error page until you manually right-clicked → "Refresh cache of current page" on each one. SF now connects to the OBS WebSocket plugin on startup and refreshes those sources automatically.

Setup in **Settings → OBS Overlays → Auto-refresh OBS browser sources** — paste your OBS WebSocket password if you have auth on, then it Just Works on every launch.

### 🎨 OBS chat overlay polish

- **TikTok gifts can land outside the chat box.** Two new placement options ("Right column" / "Left column") in the gift-float-position picker — chat shrinks horizontally to make room so gifts and chat never overlap.
- **Cross-platform events can sit in side columns** (left or right of the chat box), same as TikTok gifts. New options in the event-placement picker.
- **New "Box (grey)" theme** for the horizontal chat overlay — same framed look as the gradient box, just plain grey for streamers who want the panel without the stylized accent.
- **Vertical chat overlay readability** — multi-layer outline + heavier message-body weight so chat reads on bright scenes without needing a panel behind it.
- **Vertical gifts** now drift past the most recent chat message instead of floating in empty space at the top of the canvas.
- **Pop-out events now sit below the chat-send bar** (max 3 visible) so they never compress chat. Big-event banners (raids, gift bombs, hype) moved from screen-center to the top of the pop-out window so they stop covering chat.

### ⌨️ Hotbar slots → keyboard hotkeys

Each hotbar slot can now bind a global keyboard accelerator — `F13`, `Ctrl+Shift+1`, `Mouse4`, `Mouse5`, etc. The combo fires the slot from anywhere, even when SF isn't focused. Works great with multi-button gaming mice: map each physical button to a unique combo in your mouse software (Logitech G HUB, Razer Synapse, etc. — `F13`–`F18` are clean choices), then bind those combos to hotbar slots.

In the hotbar editor each slot has a small input + ⌨ capture button — click it then press your combo, SF detects it and saves automatically.

### ⚙️ Aquilo Loadout activity in the events feed

Loadout SB-kit widget clicks now auto-surface into the events feed as `Loadout — &lt;Action&gt; fired` rows. Kits that emit `aquilo_loadout_event` outcome broadcasts (success / failure) replace the auto-row with a richer row when both arrive within 2 seconds. New `stat` widget type for passive Bolts / point-style readouts.

### 🧪 Test triggers

**Settings → Events → Test Triggers** has a row of buttons that fire sample events (Twitch follow / sub / cheer / raid, TikTok gift, Kick sub, tip, song request flavors, Loadout fire / success / failure, ticker chat msg) through the real flow. Useful for confirming a styling change without waiting for a real event.

### 🔧 Miscellaneous

- Discord-connect button SVG cleanup in Patreon auth (was a malformed inline path).
- Better error message when the Discord shared bot rejects an outdated token (`bot_service_rejected`).
- Cleaner error surfacing for Raid Finder failures + verbose `[SF rf v5]` diagnostic logging in the Streamer.bot action so failures are debuggable from SB's Logs tab.
- Rotation watchdog: heartbeat watchdog auto-recovers the SF link when a fetch hangs for over a minute.

---

## Technical details

The full beta arc (`1.5.5-beta.0` through `1.5.5-beta.14`) covers:

- Aquilo product integration protocol additions: control-stream SSE for SF → companion-product directives, `pushControl()` API, song-request event push channel.
- Loadout protocol additions: new `stat` widget type, new `aquilo_loadout_event` broadcast source for outcome events.
- Cloud-relay event handler in `index.html` got a real-requester predicate (`'anonymous' / 'anon' / 'viewer' / 'someone'` → false) so placeholder usernames never surface as if they were real handles.
- New `obs-overlays/ticker.html` with CSS-driven right-to-left chip animation, queue-paced spawning, and full platform-color matrix including the new `rotation` (Spotify) platform.
- OBS WebSocket v5 auto-refresh client implemented inline in `main.js` against the `ws` package; handles auth handshake, filters browser sources by URL match against SF loopback ports, presses `refreshnocache` on matches.
- Per-slot hotbar hotkey registration via `globalShortcut` + sync IPC from renderer; tracks own registrations so other features' shortcuts stay intact.
- Vertical overlay perf: trimmed text-shadow stack from 6 layers to 3, dropped infinite gift wobble + halo animations, added `contain: layout paint style` on the chat bar.

Auth regression guard: 16/16 PASS across the entire beta arc.

Per-beta release notes for the full diff: see `scripts/release-notes-1.5.5-beta.{0..14}.md`.
