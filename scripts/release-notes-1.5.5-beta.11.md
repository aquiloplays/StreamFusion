# StreamFusion 1.5.5-beta.11

## What's new for you

📺 **Horizontal Ticker overlay.** A new chat overlay where messages slide right-to-left across a thin strip — drop it on the top or bottom of your scene as a band. Each message becomes a chip with the platform icon, username, and the message text scrolling smoothly off the left edge. Fourth chat-overlay variant alongside the existing card / box / vertical-bar styles.

Find it in **Settings → OBS Overlays → Horizontal Ticker**. Default recommended OBS browser-source size is **1920×60** (full-width strip on a 1080p stream). Pick top or bottom anchor in the settings panel.

### What's tunable

- **Font size** (12–40 px)
- **Bar height** (32–120 px)
- **Scroll duration** (8–60 s — longer = slower)
- **Bar opacity** (0 = transparent, 100 = solid)
- **Position** (top / bottom)
- **Max queue depth** — hard cap on pending messages during a sub-bomb
- Profile pictures / platform icons / emotes toggles

The ticker receives the same chat broadcasts the chat-feed and vertical-bar overlays do, so it Just Works alongside them — turn one off in OBS if you only want the new look.

---

## Technical details

### New overlay file

`obs-overlays/ticker.html` — full-width strip, chips spawn at the right edge with `transform: translateX(100%)` and animate to `translateX(calc(-100vw - 100%))` over the configured `--scroll-dur`. Cleanup on a hard timeout (animation duration + 500ms) so a paused tab or visibility change doesn't strand chips in the DOM.

Spawn pacing: a small queue (`pendingQueue`) drains via `scheduleSpawn` with a `spawnGapMs` derived from `scrollDur * 0.18` — slower scrolls naturally space chips farther apart. Cap of `maxQueue` (default 50) drops oldest pending messages on overflow.

CSS-driven animation rather than per-frame JS keeps the chip motion on the GPU compositor layer, plus auto-pauses cleanly on tab visibility / OBS scene hide. Lean text-shadow recipe (2 hard offsets + 1 soft halo, same as the vertical overlay's beta.9 reset) so multi-chip bursts don't tank the compositor.

### Server / dispatcher

- `obs-server.js` adds `/ticker` to the route switch (gated behind `isEntitled` like the rest), `lastConfig.ticker = {}`, and the URL to `getUrls()` + the landing page list.
- `main.js`'s `obs-broadcast-chat` handler fans the chat data to `['chat', 'vertical', 'ticker']` instead of `['chat', 'vertical']`. Each overlay decides whether to render based on its own config.
- `obs-set-config('ticker', cfg)` works through the existing IPC bridge — no preload changes needed.

### Settings UI

`updateObsConfig('ticker')` builds the cfg object from the new `obsTicker*` inputs, mirrors it into `S.obsCfg.ticker`, and pushes via `obsSetConfig` IPC. Hydration in the existing `if (c.ticker) {...}` block restores the inputs from saved settings on every panel open.

### Notes

- Auth regression: 16/16 PASS.
- Backward-compatible. Existing chat / vertical / alerts / shoutout overlays unchanged.
- Rotation song-request rows route through chat broadcasts the same way, so they show up in the ticker too with the Spotify-green pill + glyph.
