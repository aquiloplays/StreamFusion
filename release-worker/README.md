# StreamFusion release-worker

Cloudflare Worker that owns the `/post-release` endpoint. Split out from
`bot-service/index.js` so the always-on Railway service can stay focused
on the only thing it actually needs to be there for: holding a Discord
**Gateway WebSocket** + fanning events out via **SSE** to EA users'
StreamFusion installs.

## What stays where

| Concern | Where | Why |
|---|---|---|
| `POST /post-release` (release-notes embed) | **This Worker** | Pure REST, infrequent traffic, free on Cloudflare |
| `POST /associate`, `DELETE /associate`, `GET /events` (SSE) | Railway `bot-service` | Long-lived SSE clients + persistent Discord Gateway WebSocket |
| `GET /bot-invite`, `GET /health` | Railway `bot-service` | Low-traffic helpers, kept with the Gateway service |

## Migrate the release path

```bash
cd ~/Desktop/StreamFusion/release-worker
npm install
npx wrangler login
npx wrangler secret put DISCORD_BOT_TOKEN     # the SF bot token
npx wrangler secret put RELEASE_POST_SECRET   # match what GitHub Actions sends
npx wrangler deploy
```

The Worker prints a `*.workers.dev` URL. Update **two** places:

1. **`scripts/post-release-notes.js`** (or wherever the release workflow
   posts) — change the target URL from `https://<railway-host>/post-release`
   to `https://sf-release.<your-cf-account>.workers.dev/post-release`.
2. **GitHub Actions workflow** — same URL change in the secrets / env if
   you've parameterized it there.

After a successful test release, you can:

- Remove the `/post-release` handler from `bot-service/index.js` (the
  ~150 lines of `handlePostRelease`, `discordRest`, `readJsonBody` —
  the `bot-service` keeps the rest)
- Drop the `RELEASE_POST_SECRET` env var from Railway

## Why not move the whole service

Cloudflare Workers can't do two things `bot-service` needs:

1. **Persistent outbound WebSocket to Discord Gateway.** Workers terminate
   subrequest sockets and don't have a "stay connected forever" model.
   Discord's gateway requires a continuous heartbeat every ~41 seconds.
2. **Long-lived inbound SSE connections to N clients.** Workers' free
   tier has a 30-second per-request CPU/wall-clock limit; even with
   Durable Objects the cost calculus shifts away from the Railway dyno
   we already have running.

So the right shape is: REST → Workers (free), persistent connections →
Railway ($5/mo well spent).
