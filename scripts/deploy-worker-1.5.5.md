# Cloudflare Worker deploy — beta-updater-token endpoint

The 1.5.5 SF release adds a Worker-vended beta-updater PAT so Tier 3 patrons
no longer manage `userData/beta-updater-token.txt` by hand. The Worker
needs one extra route deployed.

## What changes server-side

Single new route on `streamfusion-patreon-proxy.bisherclay.workers.dev`:

```
POST /beta-updater-token
  body: { "patreonAccessToken": "..." }

  -> 200 { ok, token, email, tier, expiresHint }     when verified Tier 3
  -> 403 { ok:false, error:"not_tier3", tier, email } when not Tier 3
  -> 502 { ok:false, error:"patreon_check_failed" }    when Patreon API errors
```

The verifier calls Patreon `/oauth2/v2/identity?include=memberships` with
the user's access token and matches:
- `currently_entitled_amount_cents >= 1000` → tier3 (entitled)
- `patron_status == declined_patron|former_patron` → blocked
- email == `bisherclay@gmail.com` → owner bypass (always tier3)

Same rules as `patreon-auth.js` inside the SF app.

## Deploy steps

1. **No new secrets needed.** The endpoint reuses the existing
   `GITHUB_BETA_TOKEN` secret already configured for `/beta-download/*`.

2. **Open the Cloudflare dashboard** → Workers & Pages →
   `streamfusion-patreon-proxy` → Edit code.

3. **Replace the Worker script** with the contents of
   `patreon-proxy.worker.js` from this repo at HEAD.

4. **Save and Deploy**.

5. **Smoke test** from any machine:
   ```bash
   curl -X POST https://streamfusion-patreon-proxy.bisherclay.workers.dev/beta-updater-token \
     -H 'Content-Type: application/json' \
     -d '{"patreonAccessToken":"<your real Patreon access token>"}'
   ```
   Expected: `{"ok":true,"token":"ghp_...","email":"...","tier":"tier3","expiresHint":86400000}`.

   With a bogus token: `{"ok":false,"error":"patreon_check_failed",...}` (502).

   With a non-Tier-3 patron's token: `{"ok":false,"error":"not_tier3","tier":"tier1|tier2|none"}` (403).

## Rollout plan

1. Deploy Worker (above).
2. Ship SF 1.5.5 (next release after this batch). The new fetch-PAT logic
   only fires for beta builds, so stable installs are unaffected.
3. Tier 3 patrons running 1.5.5-beta get their PAT auto-vended on launch.
   The `userData/beta-updater-token.txt` file is now written by SF, not the user.
4. Existing patrons who hand-managed the file keep working (the cached
   on-disk PAT is preserved when the Worker is unreachable).
5. Rotate `GITHUB_BETA_TOKEN` whenever you want — the next launch of every
   patron's SF re-fetches and re-caches.

## Revoking a demoted patron

When a Tier 3 patron drops to Tier 2 / unsubs:
- Their next Patreon-token check returns `currently_entitled_amount_cents < 1000`.
- The Worker responds 403 with `error: "not_tier3"`.
- SF wipes `userData/beta-updater-token.txt` immediately.
- The user remains on whatever beta version they last installed but
  receives no further updates.

No manual action required.
