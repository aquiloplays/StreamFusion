# StreamFusion 1.6.0-beta.1

## What's new for you

⚠️ **Final StreamFusion Beta release.** The Beta variant is being merged into the main StreamFusion app. **1.6.0 stable already shipped** — please download it from the releases page and migrate.

On launch this build shows a one-time notice with three buttons: open the download page, dismiss for now (we'll re-prompt next launch), or silence the notice. Click "Open download page" → install StreamFusion (the merged app) → uninstall this Beta variant once you've confirmed the new install works.

**Why the migration?** In 1.6.0 the same single download covers Free / Tier 2 / Tier 3 — Patreon tier picks the runtime theme + icon at sign-in time. Tier 3 supporters get a gold + violet theme that flips on automatically when Patreon entitlement updates land. No more separate Beta install + Cloudflare-PAT delivery + dual-channel auto-updater.

**Your settings carry over.** The merged StreamFusion uses a different user-data directory than the Beta variant, but settings export / import is in **Settings → About** if you want to copy specific things across.

After you've migrated, the `aquiloplays/StreamFusion-beta` repo will get archived in a few weeks. No further beta releases will ship.

---

## Technical details

This build is identical to `1.6.0` stable except:

- Version is `1.6.0-beta.1` instead of `1.6.0`
- Auto-updater channel is `beta.yml` instead of `latest.yml`
- Built with the beta NSIS config (`StreamFusion Beta` install path / appId)

The full code change vs `1.6.0-beta.0`: a new `maybeShowBetaVariantMigrationNotice()` in `main.js` that fires only when `_isBetaVariant()` is true. Three-option dialog (`Open download page` / `Dismiss` / `Don't show again`) gated by a marker file in userData so it doesn't re-fire after the streamer dismisses or silences it. Stable runs ship the same code but the notice never fires (`_isBetaVariant()` is false in stable).

Auth regression: 16/16 PASS.

### Notes

- This is intentionally the LAST 1.6.x-beta.* release on the StreamFusion-beta repo. The merge is done.
- If you don't migrate, this build will keep working as-is — just no further updates from the beta channel.
