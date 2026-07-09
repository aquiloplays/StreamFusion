# StreamFusion 1.22.0: viewer counts you can trust

Viewer counts were the least trustworthy number in the app: slow to move,
frozen after a stream ended, and quietly wrong on the OBS overlay. This
release rebuilds the whole pipeline — every platform updates faster, offline
means zero, and every surface finally agrees on the same number.

## ⚡ Faster on every platform

- **Twitch**: when you're signed in with Twitch, the count now comes straight
  from the authenticated Twitch API every 30 seconds — no more third-party
  detours. Without a sign-in the keyless fallback still runs every 60s.
- **Kick**: polling doubled to every 30 seconds, now riding the app's real
  browser network stack so Kick's bot protection stops silently freezing the
  count. If Kick does throttle us, StreamFusion backs off politely and
  recovers on its own.
- **YouTube**: previously had **no reliable source at all** — if Streamer.bot
  didn't volunteer a count, YT sat frozen at "–" all stream. It now has its
  own direct poll (60s, no API key, no quota) that works regardless of your
  Streamer.bot version, and it tracks the *current* broadcast even if you
  stream twice in one session.
- **Going live**: the count appears seconds after you start streaming instead
  of on the next minute tick.

## 🎯 Accurate — offline means zero

- Ending a stream now zeroes that platform's count everywhere within moments.
  Previously the last live number would stick around **forever** — on the top
  bar, in the total, and on the OBS viewers overlay — until you restarted.
- TikTok can finally show a real 0, drops instantly when TikFinity disconnects
  or the LIVE ends, and auto-connects on a fresh install without needing a
  settings save first.
- A shared freshness rule keeps the top-bar chips, the grand total, the
  pop-out stats bar and the OBS overlay **in agreement**: a platform whose
  data went stale drops out of all of them at the same time, instead of
  ghost-counting in some and vanishing from others.
- A Streamer.bot reconnect blip no longer wipes your Kick count or collapses
  the total to TikTok-only — sources that don't depend on Streamer.bot keep
  right on counting.
- Loading an OBS scene hours after a stream no longer resurrects dead numbers
  (and the goals overlay now gets the same instant-on replay the viewers
  overlay had).

## 📡 Better radar reporting

The aquilo.gg live radar heartbeat now reuses the app's own fresh count (no
more disagreeing with what's on your screen) and reports your per-platform
breakdown and true combined total — including TikTok, which only StreamFusion
can see.
