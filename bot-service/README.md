# StreamFusion bot service

Hosted Discord bot + SSE push service for StreamFusion EA. Runs on Railway (or any always-on Node 18+ host). See [SETUP-PATREON.md](../SETUP-PATREON.md) at the repo root for the step-by-step deployment walkthrough.

**Do not bundle this folder into the StreamFusion Electron app.** It's a separate service. The root `package.json`'s `build.files` excludes it.

## What it does

- Maintains one Discord Gateway WebSocket connection with the aquilo.gg StreamFusion bot token
- Accepts SF clients connecting via SSE at `/events?token=<patreon_access_token>`
- Verifies each connecting user is an active Tier 2 / Tier 3 Patreon supporter
- Lets supporters associate their own Discord server(s) with their SF install via `POST /associate`
- Forwards member-join, voice-join, and message events from the guild to the right SF client

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status: gateway connected, guild count, user count |
| GET | `/bot-invite` | returns the bot's invite URL for the dashboard |
| GET | `/events?token=...` | SSE stream to a single SF client |
| POST | `/associate` | `{ patreonAccessToken, guildId }` → binds a user to a guild |
| DELETE | `/associate` | same shape; removes the binding |

## Environment variables

Set these on Railway (Variables tab):

```
DISCORD_BOT_TOKEN          the bot token from discord.com/developers
DISCORD_BOT_CLIENT_ID      the application/client id (for the invite URL)
PATREON_CAMPAIGN_ID        same value as in patreon-auth.js
PATREON_TIER2_ID           same value as in patreon-auth.js
PATREON_TIER3_ID           same value as in patreon-auth.js
```

`PORT` is provided automatically by Railway.

## Storage

All state (guild → users, user → SSE connections) is in-memory. A service restart drops associations; each SF client re-issues `POST /associate` when its SSE reconnects, so the system self-heals within seconds. For multi-instance deployments you'd swap in Redis or Postgres here — unnecessary at EA scale.
