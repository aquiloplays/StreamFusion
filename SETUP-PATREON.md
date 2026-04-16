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
- [`patreon-proxy.worker.js`](patreon-proxy.worker.js) — Cloudflare Worker (deploy separately; **not** bundled into the app)
- [`preload.js`](preload.js) — exposes the entitlement API to the renderer
- [`main.js`](main.js) — wires entitlement service to app lifecycle
- [`index.html`](index.html) — onboarding Page 9 + Settings → Early Access + `S.hasEarlyAccess` state flag
