# StreamFusion — Patreon Early Access Setup

This guide covers the one-time setup needed to let Patreon supporters unlock Early Access features inside StreamFusion. Ship this once, then every new EA feature just needs a `if (S.hasEarlyAccess)` check.

---

## How it works at a glance

- **One installer.** Everyone runs the same `StreamFusion.exe`.
- **Optional sign-in.** The onboarding wizard has a "Connect Patreon" step (Page 9). Users can skip it; the app works normally without a Patreon connection. They can connect later via **Settings → Early Access**.
- **Tier-gated.** Only users with an active membership on **Tier 2** or **Tier 3** of your campaign are considered entitled. Tier 1, followers, and declined/former patrons are not.
- **Live check.** StreamFusion verifies against Patreon on every launch and once per hour while running. If a supporter cancels their pledge, their Early Access unlocks disappear within an hour — no restart needed.
- **Offline grace.** If Patreon is unreachable, the last known entitlement is honored for 7 days before locking out.
- **Client secret never ships.** Token exchange is proxied through a Cloudflare Worker that holds the secret server-side.

---

## One-time setup (you)

### 1. Register a Patreon OAuth client

1. Go to https://www.patreon.com/portal/registration/register-clients while logged in as the creator
2. Create a new client:
   - **App Name**: StreamFusion
   - **Description**: StreamFusion desktop app — early access membership check
   - **App Category**: pick what fits
   - **Redirect URIs** (add all three):
     - `http://127.0.0.1:17823/callback`
     - `http://127.0.0.1:17824/callback`
     - `http://127.0.0.1:17825/callback`
   - **Scopes**: `identity`, `identity.memberships`
3. Save and copy the **Client ID** and **Client Secret** (secret is only shown once — grab it now).

### 2. Find your Campaign ID + Tier IDs

On the Patreon OAuth client page you'll also see a **Creator's Access Token**. Use it:

```bash
curl -H "Authorization: Bearer <creator-access-token>" \
  "https://www.patreon.com/api/oauth2/v2/campaigns?include=tiers&fields%5Btier%5D=title,amount_cents"
```

The response gives you:
- `data[0].id` → your **Campaign ID**
- `included[]` (where `type === "tier"`) → each of your tiers with `id`, `title`, and `amount_cents`

Identify your Tier 2 and Tier 3 IDs from the titles / amounts. Save all three IDs.

### 3. Deploy the Cloudflare Worker

The desktop app sends auth codes to a Worker that holds your client secret. Worker source is in [`patreon-proxy.worker.js`](patreon-proxy.worker.js).

```bash
npm install -g wrangler
wrangler login

# Create the Worker (one-time)
wrangler init streamfusion-patreon-proxy --yes
cd streamfusion-patreon-proxy
# Replace the generated worker script's content with patreon-proxy.worker.js

# Set secrets (entered interactively, never committed)
wrangler secret put PATREON_CLIENT_ID
wrangler secret put PATREON_CLIENT_SECRET

# Deploy
wrangler deploy
```

Cloudflare gives you a URL like `https://streamfusion-patreon-proxy.<your-account>.workers.dev`. Optionally bind a custom route (e.g. `auth.aquilo.gg/patreon/token`) in the Cloudflare dashboard for a cleaner URL.

### 4. Fill in the constants

Open [`patreon-auth.js`](patreon-auth.js) and replace these at the top of the file:

```js
const PATREON_CLIENT_ID   = 'REPLACE_WITH_YOUR_PATREON_CLIENT_ID';
const PATREON_CAMPAIGN_ID = 'REPLACE_WITH_YOUR_CAMPAIGN_ID';
const PATREON_TIER_IDS = {
  tier2: 'REPLACE_WITH_TIER2_ID',
  tier3: 'REPLACE_WITH_TIER3_ID'
};
const TOKEN_PROXY_URL     = 'https://auth.aquilo.gg/patreon/token';
```

All four values are public info — Client ID, Campaign ID, Tier IDs, and proxy URL are safe to commit. The only secret (Client Secret) lives on the Worker.

Alternatively, leave the placeholders and set env vars at build time:
- `SF_PATREON_CLIENT_ID`
- `SF_PATREON_CAMPAIGN_ID`
- `SF_PATREON_TIER2_ID`
- `SF_PATREON_TIER3_ID`
- `SF_TOKEN_PROXY_URL`

### 5. Build + ship

```bash
npm run build         # → dist/StreamFusion Setup 1.2.3.exe
```

No separate EA installer — this is the only build you need.

---

## Adding an Early Access feature

### In the renderer (anywhere inside `index.html` and its scripts)

```js
if (S.hasEarlyAccess) {
  // Show / enable the EA-only thing
}
```

To react to changes (e.g. a feature panel that should hide live when a user signs out):

```js
window.electronAPI.onPatreonEntitlementChanged(function(state) {
  document.getElementById('myEaPanel').style.display = state.entitled ? '' : 'none';
});
```

### In the main process (`main.js`)

If you need to register an IPC handler that only the entitled user should hit, guard the handler body:

```js
ipcMain.handle('my-ea-feature', async function() {
  var state = await patreonAuth.getEntitlement();
  if (!state.entitled) return { error: 'requires_early_access' };
  // ... do the thing
});
```

### Graduating a feature to stable

Delete the check. That's it.

---

## What users see

**First launch (new user):**
1. App opens normally (no gate)
2. Onboarding walks through 11 steps
3. Step 9 — "Unlock Early Access" — with a red **Connect Patreon** button and a **Skip for now** button
4. If they click Connect → Patreon opens in browser → they authorize → browser tab closes → StreamFusion updates live showing their tier and whether Early Access is unlocked
5. Step 10 — "You're ready to stream!" — familiar finale

**Existing user (skipped onboarding or wants to change accounts):**
- **Settings → Early Access** — shows current connection status, Connect / Re-check / Sign out buttons

**Runtime:**
- No status indicator by default (add one wherever you like using `S.hasEarlyAccess`). The entitlement is re-checked every hour automatically.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Sign-in failed" with no detail | Check Cloudflare Worker logs: `wrangler tail`. Most commonly the Client Secret isn't set or is wrong. |
| User is an active Tier 2 patron but shows "not_a_member" | Your `PATREON_CAMPAIGN_ID` is wrong, or they pledged to a different campaign. Verify with `/api/oauth2/v2/identity?include=memberships,memberships.campaign` using their token. |
| User is Tier 2 but sees "insufficient_tier" | Your `PATREON_TIER_IDS.tier2` value doesn't match the actual tier ID. Re-check via the campaigns endpoint in step 2. |
| "OAuth error: invalid_grant" on retry | Auth codes are single-use — the user probably clicked the callback twice. They just need to start the flow again. |
| "No loopback port available" | Another app is using all three of 17823/17824/17825 at once, which is extremely unusual. Pick different ports in `patreon-auth.js` and re-register the redirect URIs on the Patreon OAuth client page. |
| Entitlement doesn't update after the user upgrades their tier | Wait up to an hour (runtime re-check interval), or have them click **Re-check membership** in Settings → Early Access. |

---

## File map

Patreon-related files:

- [`patreon-auth.js`](patreon-auth.js) — OAuth flow, tier-aware membership verification, encrypted token cache, periodic re-check
- [`patreon-proxy.worker.js`](patreon-proxy.worker.js) — Cloudflare Worker (Patreon token proxy + community-recap forwarder; deploy separately; **not** bundled into the app)
- [`preload.js`](preload.js) — exposes the entitlement API to the renderer
- [`main.js`](main.js) — wires entitlement service to app lifecycle
- [`index.html`](index.html) — onboarding Page 9 + Settings → Early Access + `S.hasEarlyAccess` state flag

---

## Community recap sharing (optional)

EA supporters can opt into sharing their stream recap to your aquilo.gg community Discord. SF posts the recap embed to your Cloudflare Worker at `/community-recap`; the Worker adds your webhook URL server-side and forwards to Discord. The webhook URL is never exposed to the app or the repo.

To enable:

1. Go to **your Discord server** → Server Settings → Integrations → Webhooks → **New Webhook**
2. Name it `StreamFusion Recaps`, pick a channel (e.g. `#stream-recaps`)
3. **Copy Webhook URL**
4. On your Cloudflare Worker → Settings → Variables and Secrets → add:
   - `COMMUNITY_RECAP_WEBHOOK` = the URL you copied (encrypted secret)
5. Deploy the Worker

Supporters will see the toggle in **Settings → Discord+ → Community Sharing**. When on, every stream recap posts to both their own webhook AND the community channel.

---

## Shared StreamFusion bot (Railway)

For the Discord bot that surfaces member/voice/message joins into supporters' Events panels, you host **one bot** that every EA supporter invites. The bot lives in [`bot-service/`](bot-service/) and deploys to Railway.

### 1. Register the Discord application

1. https://discord.com/developers/applications → **New Application** → name it `StreamFusion`
2. **Bot** tab → **Add Bot** → copy the **Token** (shown once)
3. Scroll down → enable **SERVER MEMBERS INTENT** (required for join events)
4. **General Information** tab → copy the **Application ID** (this is the Client ID)

### 2. Deploy to Railway

```bash
# From the StreamFusion repo root
cd bot-service
npm install wrangler  # or use Railway dashboard

# Option A — Railway CLI
railway login
railway init
railway up

# Option B — Railway dashboard
# Create a new project → Deploy from GitHub → point at the bot-service folder
```

### 3. Set Railway environment variables

Open your Railway project → Variables tab → add:

```
DISCORD_BOT_TOKEN         = <from step 1>
DISCORD_BOT_CLIENT_ID     = <from step 1>
PATREON_CAMPAIGN_ID       = <same value as patreon-auth.js>
PATREON_TIER2_ID          = <same value as patreon-auth.js>
PATREON_TIER3_ID          = <same value as patreon-auth.js>
```

Redeploy after saving. Railway gives you a public URL like `https://streamfusion-bot-production.up.railway.app`.

### 4. Point StreamFusion at the deployed service

In [`index.html`](index.html) around the top of the Discord+ JS block, update the default value of `BOT_SERVICE_URL`:

```js
var BOT_SERVICE_URL = (window.__SF_BOT_SERVICE_URL || 'https://your-railway-url.up.railway.app').replace(/\/$/, '');
```

Or set a custom domain (e.g. `bot.aquilo.gg`) in Railway and use that.

### 5. Health check

Visit `https://your-railway-url.up.railway.app/health` — you should see:

```json
{ "ok": true, "gateway": true, "guildCount": 0, "userCount": 0, "botInvite": "https://discord.com/api/oauth2/authorize?client_id=..." }
```

If `gateway: false`, the bot couldn't connect to Discord. Check the Railway logs for which close code came back — most commonly you need to toggle on the SERVER MEMBERS intent (step 1.3).

### How supporters use it

1. In StreamFusion → Settings → **Discord+**
2. Click **Invite StreamFusion bot** — opens Discord, they pick their server, click Authorize
3. Back in StreamFusion, paste their **server ID** (Discord settings → enable Developer Mode, right-click server name → Copy Server ID)
4. Click **Connect** — SF opens an SSE stream to your Railway service, authenticated by the user's Patreon access token
5. From then on, member/voice/message joins in their server appear in SF's Events panel

**No dev-portal setup on the supporter's end.** They just invite a button and paste an ID.

### Scale notes

- **In-memory storage.** The service keeps `guildId → users` and `userId → SSE connections` in RAM. A restart drops associations; SF clients re-POST `/associate` on reconnect, so the system self-heals within seconds. For multi-instance deployments swap in Redis or Railway Postgres.
- **Pre-verification only.** Discord requires bot verification at 100 servers and limits new invites to unverified bots at 75. For EA supporter scale this is plenty of headroom. When you approach that ceiling, apply for verification — Discord has an EU-based team and the process takes 2–4 weeks.
- **Cost.** Free tier on Railway gives $5/month of usage credit; a single always-on Node service runs well under that. Upgrade if you exceed it.
