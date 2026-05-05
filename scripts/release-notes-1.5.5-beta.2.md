# StreamFusion 1.5.5-beta.2

## What's new for you

🎵 **Now-playing controls in the pop-out.** The Rotation song strip on your second-monitor pop-out now has prev / play-pause / skip buttons, same as the main app. Drive Spotify without alt-tabbing.

🎚️ **TikTok gifts + events can land OUTSIDE the chat box.** Two new placement options in **Settings → OBS → Chat overlay**: gifts can fall down a left or right column instead of drifting across the top, and any platform's events can sit in their own side strip. Chat shrinks horizontally to make room — they never overlap.

🎨 **New "Box (grey)" chat-overlay theme.** Same framed look as the gradient box, just plain grey for streamers who want the panel without the stylized accent.

⚙️ **Now-playing bar can be turned off.** New toggle in **Settings → Integrations → Rotation Widget** — show or hide the bar. Default on. State persists across restarts.

📐 **Pop-out cleanup.** Events now show below the chat-send bar (never compress chat) and the cap dropped from 5 → 3 visible cards.

✨ **Vertical chat overlay events** are now centered pills instead of left-bordered bars. Slightly larger text, tighter footprint.

🔧 **Rotation reliability**: a heartbeat watchdog in the widget recovers the link automatically if a hung fetch ever leaves it appearing connected but stuck.

🩹 **Misc fixes**: cleaner Discord logo on the "Connect Discord" button in Patreon auth; clearer error message when the shared bot service rejects an outdated token.

---

## Technical details

### Pop-out (`overlay.html`)

- **Event area moved below chat-send bar.** Previously sat between feed and input as an in-flow flex item; events would compress the feed on burst arrivals. Now it's the last child in the body's flex column, sitting beneath `.ov-chat-bar`. Hard cap dropped from 5 → 3 (`OV_EV_MAX = 3`); `max-height` reduced 50vh → 35vh; added `border-top` so it visually separates from chat.
- **Rotation now-playing strip** added under the live-bar, fed by a new `rotation-now-playing` overlay-data type. Auto-hides 30s after the last update.
- **Transport controls in the pop-out strip** call `electronAPI.obsControlIntegration(clientId, command)` via the shared `preload.js`. Buttons disable with a `(widget offline)` tooltip suffix when no clientId is in the packet (cloud-relay-only setups). Optimistic local toggle for play/pause icon flip.

### Now-playing card (main app)

- New `_npPushToOverlay()` helper mirrors `_npState` to the pop-out from the existing `_renderNowPlayingBar` flow, so the pop-out's strip stays alive on integration-heartbeat cadence (30s) and picks up `clientId` immediately when the local widget registers.
- New user toggle `showNowPlaying` (default true) persisted in `sf_settings`. Lives in **Settings → Integrations → Rotation Widget**. When off, the bar hides and the progress ticker is cleared. State accumulates in `_npState` regardless, so flipping back on restores instantly.

### Chat overlay placement (`obs-overlays/chat.html`)

- New CFG field `ttGiftSide: 'top' | 'right' | 'left' | 'off'`. `top` is legacy (gift drift across upper 50vh); `right`/`left` pin gifts to a 160px column with new vertical drift keyframes (`giftFloatV`).
- `eventPlacement` gains `'left'` and `'right'`. New `#events-left` / `#events-right` hosts with a 220px column.
- Chat box auto-shrinks horizontally via `body.theme-box.tt-gift-side-right #feed { right: calc(10px + var(--gift-side-w, 160px)); }` and analogous rules for `theme-nobg`, `theme-card`, and the event-side variants.
- When gifts AND events share the same side, the column splits 50/50 and the box shrink uses `max(--gift-side-w, --event-side-w)` so it doesn't double-count.
- New theme `'box-grey'` — a plain grey panel without the blue/teal gradient. Implemented by applying both `theme-box` and `theme-box-grey` body classes so existing layout/side-mode rules keep matching with no duplication.
- Settings UI (`index.html`): event-placement dropdown gains "Side column, left of chat" / "Side column, right of chat"; new "Gift float position" dropdown; theme dropdown gains "Box (grey)".

### Vertical chat overlay (`obs-overlays/vertical.html`)

- `.ev-card` switched from full-width left-bordered bar to a centered pill (`border-radius: 999px`, `inline-flex`, `align-self: center`, `width: auto`, `max-width: calc(100% - 16px)`). Font size +2px. Platform tints use full-perimeter glow rings instead of the 4px left bar.

### Rotation widget link

- 8s `AbortSignal.timeout` on heartbeat fetches.
- `inflightHeartbeat` guard so heartbeats never stack when previous one is still pending.
- Watchdog timer (every 30s, threshold 60s): if no successful heartbeat lands in over a minute while supposedly registered, force a `dropAndReconnect()`. Catches the silently-hung-fetch case where the streamer reported "Rotation appears connected but nothing updates and skip doesn't work".
- `dropAndReconnect` resets `lastHeartbeatOkAt` + `inflightHeartbeat` so the first heartbeat after recovery is treated as a fresh baseline.

### Discord error surfacing

- `onDiscordEvent` `'fatal'` handler splits by reason. `bot_service_rejected` now reads:
  > "Discord bot: bot_service_rejected — the shared bot rejected your token (HTTP X). Disconnect + reconnect Discord in Settings → Patreon to refresh, or wait a minute and retry if Patreon just synced."

  Other reasons fall back to "check your bot token + privileged intents in Discord Developer Portal" (which is the right advice for the user-bot path but not the shared-bot path).

### Minor

- Patreon auth Discord-connect button: malformed inline SVG path replaced with `<use href="#i-discord">` referencing the existing well-formed symbol; sized 14×14 instead of 11×11.

### Notes

- Auth regression guard: 16/16 PASS.
- Additive-only protocol changes; older Aquilo Spotify Widget builds (without `playback-control` capability) keep working — the now-playing card just disables its control buttons gracefully.
