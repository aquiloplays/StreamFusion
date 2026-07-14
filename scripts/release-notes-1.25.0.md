# StreamFusion 1.25.0

A big feature + polish drop. Everything new is opt-in unless noted.

## New features
- **Giveaway / raffle** — run a keyword giveaway across every connected chat (Twitch/YouTube/Kick/TikTok). One entry per viewer, draw a random winner with a banner + confetti + OBS overlay, "draw again" excludes the last winner, optional chat announce. New **Giveaway** toolbar button.
- **Auto-shoutout on raid** — automatically `/shoutout` a raider a few seconds after they raid (opt-in, Settings → Smart Shoutouts). Honors your command template, the 2-min cooldown, a viewer-count floor, and the exclude list.
- **Auto-thank** — templated chat thank-yous for new subs, cheers and gift subs (opt-in, Settings → Integrations). `{user}`/`{amount}` placeholders, a cheer min-bits floor, and per-user + anti-flood cooldowns so it never spams.
- **Returning-viewer welcome** — greet regulars by name on their first chat of the day ("back for their 5th stream"), with a milestone celebration at 5/10/25/etc. Skips the broadcaster and common bots.
- **Rotating "in chat" bar** — a thin bar above chat that cycles through everyone active this session with their platform icon; click it for the full list.
- **Command palette (Ctrl/Cmd+K)** — fuzzy launcher to jump to any settings tab, toggle a bar, open a panel, or fire a test alert.
- **Session clip log + VOD marker** — each clip now also drops a stream marker, and clips collect in a session list (right-click the Clip button, or Ctrl+K → "Session clips") to copy links for Discord / VOD notes.
- **Native Twitch goal celebrations** — goal-reached events now fire a banner + confetti instead of being dropped.
- **Show all third-party extension events** — an opt-in verbose toggle surfaces every raw event a Streamer.bot source emits (Settings → Events → Third-party extensions).

## Readability + UX
- **Clearer data bars** — bigger, bolder numbers and better spacing on the stream-stats strip and viewer counts; per-platform viewer counts now live inside the live-bar chips, and the topbar carries the combined total.
- **Connection health strip** — the statbar shows per-platform ingest status (Twitch/YouTube/Kick via Streamer.bot, TikTok via TikFinity) at a glance; click to open Connections.
- **Hidden-events manager** — click the "N filtered" count to see exactly what's muted from the feed and un-mute it in one click.
- **Event Filters regrouped** — "Bars & alerts" (checked = shown) vs "Hide from the feed" (checked = hidden), so toggles no longer mean opposite things in the same list.
- **Colorblind-safe platform indicators** — the current-viewers list now shows platform icons, not just color.
