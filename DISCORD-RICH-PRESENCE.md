# Discord Rich Presence (user RPC) — status & implementation plan

**Status (2026-06-02 audit): NOT BUILT.** Documented here as "needs
Electron app integration" per the Batch-B audit directive.

## What this is (and isn't)

"Discord RPC / Rich Presence" = showing the **streamer's own Discord
profile** as e.g. *Playing Aquilo · Live on Twitch · Boltbound* with art +
timestamps. It is driven by a **local IPC connection** from a process on
the user's machine to their **Discord desktop client** (named pipe
`\\.\pipe\discord-ipc-0` on Windows), calling `SET_ACTIVITY`.

It is **not** any of these existing pieces (all audited, none provide it):

| Existing | What it actually does | Why it's not RPC |
|---|---|---|
| `aquilo-presence` (Railway) | Holds Gateway WS so **bots** show a green dot + bot activity | Bot presence, not the *user's* profile. Server-side; can't touch the user's Discord client. |
| `StreamFusion/discord-bot.js` | Outbound webhooks + inbound Gateway bot for the **streamer's server** | Server automation, not the local-client activity socket. |
| `StreamFusion/discord-auth.js` | OAuth/entitlement (Patron role check) | Auth only. |
| Cloudflare Workers | — | Workers can't open the local IPC pipe; RPC is impossible server-side by design. |

## Why it needs the Electron app

A browser/Worker cannot reach `discord-ipc-0`. The host must be a local
process — **StreamFusion is the natural home** (already Electron 29, already
the user's always-on streaming companion, already has stream/game state).

## Blocker (owner action)

- **A Discord application + client ID** is required (Clay, at
  <https://discord.com/developers/applications>). In that app's
  **Rich Presence → Art Assets**, upload the large/small image keys (e.g.
  `aquilo_logo`, per-game icons) the activity will reference by name.
  Without the client ID the integration can't authenticate; everything
  below is ready to wire the moment it exists.

## Implementation plan (StreamFusion main process)

1. **Dep:** `npm i discord-rpc` (or implement the raw IPC handshake over
   the named pipe — `discord-rpc` is the pragmatic choice; ~1 small dep).
2. **New module `discord-presence.js`** (main process):
   ```js
   const RPC = require('discord-rpc');
   const CLIENT_ID = '<from dev portal>';
   let client = null, ready = false;
   async function connect() {
     client = new RPC.Client({ transport: 'ipc' });
     client.on('ready', () => { ready = true; });
     try { await client.login({ clientId: CLIENT_ID }); }
     catch { ready = false; /* Discord client not running — retry later */ }
   }
   let last = 0;
   function setActivity(a) {           // a = { state, details, game, since }
     if (!ready || !client) return;
     const now = Date.now();
     if (now - last < 15000) return;   // Discord throttles SET_ACTIVITY ~5/20s
     last = now;
     client.setActivity({
       details: a.details || 'Streaming with Aquilo',
       state:   a.state   || undefined,        // e.g. "Boltbound — ranked"
       startTimestamp: a.since || undefined,
       largeImageKey: 'aquilo_logo',
       largeImageText: 'aquilo.gg',
       smallImageKey: a.game || undefined,
       instance: false,
     });
   }
   ```
3. **Lifecycle (`main.js`):** call `connect()` in `app.whenReady`
   (best-effort; the Discord desktop client may be closed — catch and retry
   on an interval / on next activity change). `client.clearActivity()` +
   destroy on `before-quit`.
4. **Activity source:** SF already tracks stream/game state (see
   `obs-server.js`, `rotation-relay-client.js`, `discord-bot.js` event
   observers). On stream-start set `since = now` + `details`; on
   category/game change update `state` + `smallImageKey`; on stream-stop
   `clearActivity()`. Reuse the existing event bus rather than adding a new
   poll.
5. **UI:** add an opt-in toggle ("Show on my Discord profile") in SF
   settings; gate `connect()` behind it (privacy — RPC reveals activity to
   the user's Discord friends).
6. **Edge cases:** Discord not installed/running → no-op (don't error);
   multiple Discord installs (stable/PTB/Canary) → `discord-rpc` probes
   `discord-ipc-0..9` automatically.

## Test

Manual: run SF with Discord desktop open + logged in → start a fake
stream → the SF user's Discord profile shows the activity card within
~15 s; stop → it clears. No automated test is practical (needs the live
Discord client).

## Estimate

~half a day once the client ID exists: module + lifecycle + wiring the
existing stream-state events + a settings toggle + manual verification.
