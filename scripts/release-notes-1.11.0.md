# StreamFusion 1.11.0

The biggest overlay + dock release yet. **Overlays now work without
StreamFusion** (Streamer.bot alone is enough), the chat dock got six
new features, and the customizer can preview every knob without you
firing real chat.

## What's new for you

### 🌐 Overlays run on Streamer.bot alone

If you've got Streamer.bot up (and optionally TikFinity) but don't have
StreamFusion running, the overlays at aquilo.gg/sf/overlay/* now
connect directly to your local SB + TF and show chat just the same.
Same browser source URLs in OBS, no second app required.

Connection details:
- Looks for SB on `ws://127.0.0.1:8080` (override via
  `?sbHost=...&sbPort=...&sbPass=...`)
- Optional TikFinity on `ws://localhost:21213` (enable via `?tf=1`)
- Falls back to a friendly "waiting for chat sources" curtain only if
  neither SF nor SB/TF are reachable
- The legacy `127.0.0.1:8787/<name>` URLs still redirect to aquilo.gg
  so existing OBS sources keep working

### 🎨 Real platform icons + broadcaster badge glyphs

The TW / YT / TT / KK chips on each chat message are now the actual
platform marks (Twitch glitch logo, YouTube play button, TikTok music
note, Kick K monogram) instead of 2-letter text. User badges (mod /
VIP / sub / broadcaster / Prime / member) render as proper SVG glyphs
(sword / heart / star / crown / diamond / star) instead of 3-letter
pills.

Real broadcaster-specific badge images from Twitch will land next
release once we proxy them through SF.

### 🚫 Block list, everywhere

Every overlay and the chat dock now have a `blockedUsers` field:
comma or space-separated chatter names, case-insensitive. Messages
*and* events (subs, gifts, cheers) from blocked users are dropped
before they hit the DOM. Configurable from the customizer (per
overlay) or the dock's Settings panel.

### 📺 Three modes for the vertical chat overlay

The vertical overlay's `chatMode` setting now picks between:

- **Sequential** (default): one message at a time, slides in, holds,
  slides out.
- **Ticker**: continuous stack at the bottom, newest at the floor,
  each bar auto-removes after `tickerHoldMs` (default 8s).
- **Ticker, on message**: same stack, but bars only drop off when a
  new message arrives and pushes the oldest out. Goes quiet when
  chat goes quiet.

All three honor `tickerMaxVisible` (default 6 visible bars).

### ▶️ Demo mode in the customizer

The customizer at aquilo.gg/sf/customize now has a demo-mode strip in
the topbar: Off / Slow / Normal / Fast auto-stream, plus single-fire
buttons for Sub / Gift / Bits / Raid / Follow. Defaults to Normal on
load so the preview iframe shows life immediately. Lets you see how
each customization knob lands in real chat conditions without waiting
for real viewer activity.

### 🆕 Customizer changes preview instantly even offline

Every overlay now listens for a `sf-customize-cfg` postMessage so
tweaks in the customizer apply to the preview iframe immediately
without round-tripping through SF. The save still happens through
StreamFusion when it's running (so OBS picks up the change too); when
SF is closed, the preview at least shows you exactly what you'd get.

## Chat Dock 2.0

The chat dock at aquilo.gg/dock/streamfusion-chat/ got six new
features in one drop:

### 🚫 Per-user block list

Same `blockedUsers` pattern as the overlays. Settings, Block specific
chatters, paste comma-separated names. Messages and events from those
users disappear from the feed; stats stay honest.

### ✨ First-time chatter and returning viewer flags

Each chat row can now carry a tiny indicator:

- **✨** the user's first chat in this dock (across all sessions)
- **👋** they're back after a 14+ day gap

The dock keeps a small last-seen index in localStorage (pruned to
5000 entries). Settings, First-time and returning viewer flags
toggles them off if you'd rather not surface that signal.

### 📊 Sub goal + hype train widgets

A new sub goal input in Settings draws a gradient progress bar under
the Subs stat (sub count over goal, capped at 100%). The Hype Train
widget under the stats grid reads Streamer.bot's HypeTrainStart /
Progress / End events; shows level, countdown, and fill bar while a
train is active.

### 💬 Send-to-chat composer at the bottom

A compose bar pinned to the bottom of the dock:

- Click any incoming message to reply: fills `@user` and narrows the
  send-target chips to that user's platform.
- Or type freeform and pick targets manually. TW / YT / KK chips,
  each toggleable.
- Enter sends through Streamer.bot's `TwitchSendMessage` /
  `YouTubeSendMessage` / `KickSendMessage` requests. Multi-target
  fan-out is one click.
- Your sent message appears inline (gold, marked self) so you can see
  what went out.

Shift-click and middle-click still save to highlights, same as
before. TikTok is a one-way receiver via TikFinity so it's not in the
target list.

### 🔊 Read-aloud (TTS)

Browser SpeechSynthesis with a rate knob (0.5 = slow, 2.0 = fast).
Strips URLs and markdown chrome, caps at 240 characters per utterance,
pauses on `visibilitychange` (so it stops when OBS hides the dock).
Skips bots, blocked users, events, and messages you sent yourself.

Settings, Read messages aloud + TTS rate.

## In the StreamFusion app

The Browser Source URL list in **Settings, OBS Overlays** now shows
the canonical `https://aquilo.gg/sf/overlay/<name>/` URLs as the value
to paste into OBS. The legacy `127.0.0.1:8787/<name>` paths still
work, they 302-redirect to the same place, so any OBS sources you
already saved keep working.

## Under the hood

- **sf-direct.js**: new shared module that opens its own SB+TF WS
  connections, parses everything into the same shape SF's SSE emits.
  Used as the bridge's fallback path when SF isn't running.
- **sf-bridge.js**: new `events(type)` method returns an EventSource-
  shaped feed regardless of whether the data comes from SF or sf-
  direct. Existing `eventsURL(type)` kept for back-compat.
- **sf-icons.js**: shared inline SVG sprite for platform + badge
  glyphs. One source of truth across every overlay.
- **Customizer schema**: `chatMode`, `tickerHoldMs`, `tickerMaxVisible`,
  `blockedUsers`, `twitchChannelId` knobs added.

## Migrating from 1.10.x

Nothing to do. Your existing overlay settings still apply; the new
defaults all match the previous behavior. The dock's new settings
default to safe values (block list empty, viewer flags on, sub goal
0, TTS off).

## Known limitations

- Real Twitch broadcaster badge images need a Helix proxy on SF's
  side; the inline SVG fallback ships today and matches the visual
  hierarchy. Helix proxy is queued for the next release.
- The dock's composer needs Streamer.bot's `TwitchSendMessage` /
  `YouTubeSendMessage` / `KickSendMessage` requests. SB 0.2.4+ ships
  these; older SB versions will get "Streamer.bot not connected" if
  you try to send.
