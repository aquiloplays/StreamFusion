# StreamFusion 1.15.0: the streamer management update

StreamFusion grows from a multi-platform chat app into a full streamer
management hub. Chat stays front and center; around it you now get a bot, a
control surface for your Twitch channel, a viewer CRM, analytics, show
planning, and deep aquilo.gg product integration.

> **One-time step:** click **Reconnect Twitch** (Settings > Accounts) once to
> grant the new permissions. Everything degrades gracefully until you do.

## 🤖 In-app bot

- **Your own bot account**: connect a second Twitch account (Settings > Bot)
  and everything the bot says posts under its name. No bot account? Messages
  post from your channel account, or through Streamer.bot.
- **Automated messages** on a timer, with a minimum-chat-lines gate so the bot
  never talks to an empty room, and a live-only mode.
- **Custom commands** with variables ({user}, {touser}, {count}, {game},
  {uptime}, {random:a|b|c}), per-command cooldowns, permission levels and
  aliases. Counters give you !deaths with mod-only + / - / set / reset.
- **Auto-moderation**: links (with !permit), caps, symbol spam, long messages,
  repeated characters, and a blocked-words list. Per-filter timeouts and
  exemption levels; mods and you are always exempt.
- **Quotes** (!quote add / random / #N) and **keyword giveaways** with sub
  luck and weighted draws.
- **Works without Streamer.bot**: turn on the EventSub toggle and StreamFusion
  reads Twitch chat natively, so the whole bot runs standalone.

## 🎛️ Stream control (new Stream tab)

Drive Twitch without leaving StreamFusion: edit your **title and category**,
see the **next ad countdown** with snooze and run-now, launch and resolve
**polls and predictions**, drop **VOD markers**, and manage your
channel-point **redemption queue**. Every action is bindable to a **global
hotkey**, including Mouse4/Mouse5 and F13-F24 for Logitech/Razer macro keys.

## 📅 Go-live schedule

Define weekly slots (title, category, tags, go-live announcement) and
StreamFusion applies the matching one to your channel automatically the
moment you go live.

## 👥 Viewer CRM (new Viewers tab)

Every chatter gets a profile: messages, days seen, all-time support, first and
last seen, plus your private notes and tags. Click any name in chat to open
their card with quick reply and mod actions. Stored only on your device.

## 📊 Analytics (new Analytics tab)

Every stream is summarized on end: viewers, follows, subs, revenue and
messages across **Twitch, YouTube, Kick and TikTok**, with per-platform
breakdowns, your best game, your best day of the week, and a recent-streams
list.

## ✅ Show ops (new Ops tab)

A **pre-stream checklist** that resets itself each go-live, and a **show
rundown**: plan timed segments and run a live countdown that follows you in
the main window's live bar and on the pop-out overlay, turning red when a
segment runs over.

## ⚡ Accurate Twitch events

With the EventSub toggle on, hype trains, ad breaks, polls, predictions,
charity campaigns, incoming shoutouts, power-ups and suspicious-user flags
come **straight from Twitch** with exact numbers, deduplicated against
Streamer.bot. Suspicious accounts get an inline warning badge in chat.

## 🌉 aquilo.gg products in your events feed

Scratch tickets, the death counter, Vertibird drops, PvP, community check-ins
and more can land in the live Events feed via the activity bus (Settings >
Integrations), alongside the existing PunchCard and Jukebox integrations. A
new Events-tab filter controls all of it.

## 🚀 Performance and fixes

- **Pop-out Performance mode**: freezes animated emotes and heavy effects so
  the overlay costs nearly nothing while you game.
- **Fixed**: binding the pop-out hide/show hotkey to Mouse4/Mouse5 now
  actually works (it used to error on startup and do nothing).
- **Fixed**: the burst of "General: Custom" noise in the events feed on
  startup.
- Settings navigation is now grouped into SETUP / MANAGE / CHAT & ALERTS /
  APP sections, and a topbar Bot chip shows bot status at a glance.

Cloud sync for your bot settings with aquilo.gg is wired in and rolling out
alongside the web dashboard.
