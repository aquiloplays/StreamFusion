# StreamFusion 1.6.2

## What's new for you

🔧 **Hotfix: shared Discord bot now silently refreshes your Patreon token.** If you were seeing `Discord bot: bot_service_rejected — the shared bot rejected your token (HTTP 403)` even though your Patreon membership is fine — this fixes it. SF now refreshes the access token before handing it to the bot service, so a stale-on-disk token (Patreon's access tokens expire after ~1 month) doesn't fail the entitlement check.

You don't need to do anything: launch SF on 1.6.2, click "Connect bot" — the connection should succeed without re-authing Patreon.

If you DID disconnect+reconnect Patreon as the error suggested, no harm done — the fresh sign-in token is already valid.

---

## Technical details

### Root cause

`shared-bot-connect` IPC in `main.js` was calling `patreonAuth.getRawAccessToken()` (synchronous, returns whatever's on disk). Patreon issues access tokens with a finite lifetime (~30 days); when the disk copy expires, Patreon's identity API returns 401. The bot service interprets 401 as "user not entitled" and returns 403 to SF. The renderer surfaces that as `bot_service_rejected`.

But SF's `patreon-auth.js` ALSO has a long-lived refresh token sitting next to the access token in state — the existing entitlement-reverify path uses it to renew silently. The shared-bot path just wasn't reaching that code.

### Fix

Two changes:

1. **New `getRawAccessTokenAsync()` in `patreon-auth.js`** — async wrapper around `getRawAccessToken` that first checks `state.expires_at` and, if within 60 seconds of expiry, calls the existing `refreshTokens(refresh_token)` helper to renew silently. State gets persisted with the fresh access token + the (possibly rotated) refresh token. Falls back to returning the stale token on refresh failure so the renderer's user-friendly notice still fires for genuine sign-out cases.
2. **`shared-bot-connect` IPC** awaits `getRawAccessTokenAsync()` before handing the token to `discordBot.sharedBotConnect`. Both downstream calls (`/events` SSE + `/associate` guild registration) now receive a fresh token.

### Persistence

The refresh writes to the same on-disk state the entitlement reverify writes to, so subsequent calls (next session, hourly reverify, etc.) start from the renewed access token. No new state shape — just an additional refresh trigger.

### Auth regression

16/16 PASS — entitlement gate logic untouched. Only the token-handing-over path was fixed.

### Note

Long-running sessions (hours+) where the access token expires AFTER `sharedBotConnect` was called still have a window where the cached `sharedCfg.accessToken` is stale and reconnects can 403. A follow-up beta will refresh on each `openSse` reconnect attempt. For now, manually clicking Disconnect → Connect in Settings re-runs the IPC and gets a fresh token.
