# StreamFusion 1.12.1

A focused chat-dock update , three streamer-requested fixes:

## What's new for you

### 🔴 Uptime only counts while you're live

The Uptime stat in the chat dock now waits for your stream to actually
go live before it starts ticking. Before this it counted from when you
opened the dock; now it shows **Offline** until Streamer.bot tells the
dock your stream is on, then flips to a red live-dot + duration
counter.

Stream-live detection (in priority order):
1. Streamer.bot's `GetBroadcaster` reply with `live: true` and a
   `liveStartedAt` timestamp (multistream uses the earliest start).
2. A `StreamOnline` / `BroadcastStarted` event arriving over the SB
   WebSocket.
3. Fallback: any chat or alert activity. If you're already streaming
   when you open the dock, the first message turns on the counter.

When the stream goes offline (or `StreamOffline` arrives), the counter
resets back to "Offline" so a follow-up session starts fresh.

### 💰 Bits and coins show estimated revenue

The Bits / Coins stat now adds a green `$X est` line underneath, just
like the StreamFusion app shows during a live stream. Conversion:

- **Twitch bits**: streamer keeps about $0.01 per bit (Twitch sells 100
  bits for $1.40 to viewers; the streamer's share is roughly 70% of
  the gross).
- **TikTok coins**: streamer's net is approximately $0.005 per coin
  (TikTok takes ~50% of the ~$0.013 USD a coin is worth).

These are estimates , real payouts vary by payout tier, region,
currency, and taxes , but they match the dollar figure the SF app
surfaces during a stream so the dock numbers stay consistent.

### 🎨 Real platform logos in the dock

The Twitch / YouTube / TikTok / Kick indicators throughout the dock
(status dots in the topbar, filter chips, viewer breakdown row under
the Viewers stat) are now the actual platform marks (Twitch glitch,
YouTube play, TikTok note, Kick K) instead of 2-letter text labels.
Same SVG sprite the overlays already use, so the visual language is
consistent across SF surfaces.

## Under the hood

- New `markStreamLive()` / `markStreamOffline()` helpers manage
  `session.liveSince`. `tickRate()` reads it and either shows
  "Offline" or the elapsed time + live-dot.
- New `bitsToUsd()` / `coinsToUsd()` / `fmtUsd()` helpers. Conversion
  constants live at the top of the script (`BITS_USD_PER_UNIT`,
  `COINS_USD_PER_UNIT`) for easy tuning.
- The dock now loads `/sf/overlay/sf-icons.js` so it gets the same
  platform glyph sprite the overlays use. `.pi-glyph` class sizes
  the icons in each context (13px in status dots, 12px in chips,
  11px in viewer breakdown).

## Migrating from 1.12.0

Nothing to do. CSS + JS only on the dock side; no overlay or SF app
changes ship in this release.
