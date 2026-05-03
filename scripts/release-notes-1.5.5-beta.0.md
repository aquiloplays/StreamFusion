## What's new for you (beta)

**Beta auto-updater no longer requires a hand-managed PAT file.** This was the long-standing gotcha: the previous beta channel needed a fine-grained GitHub PAT in your `%APPDATA%\streamfusion-beta\` folder to fetch updates from the private repo. PATs got auto-revoked by GitHub's secret scanning the moment they hit a chat or a Discord message, leaving patrons stuck on whatever beta they last installed.

1.5.5-beta automates the whole flow. SF asks the Cloudflare Worker for a fresh PAT on every launch, the Worker verifies you're a current Tier 3 patron via your Patreon access token, and hands back the cached GitHub token. You never touch a PAT file again. If you drop below Tier 3 the Worker says 403 and SF wipes the cached PAT — clean revocation, no manual cleanup.

Forward-compatible: existing Tier 3 patrons with a hand-managed PAT keep working unchanged. The on-disk PAT is the fallback when the Worker is unreachable, so a Worker deploy that's mid-rollout doesn't kill anyone's auto-updates.

**Aquilo Loadout dashboard scaffolding.** The companion Aquilo Loadout Streamer.Bot kit (in development) will turn SF into a control surface for the kit's actions — soundboards, counters, toggles, chat templates, multi-loadout switching, all rendered live from a manifest the kit publishes. The kit isn't out yet but SF is ready: when the kit imports, the Loadout button appears in the toolbar and the dashboard renders automatically. Protocol contract for kit developers ships in the LOADOUT-KIT.md file at the repo root.

---

## Technical details (beta)

### A. Worker-vended beta PAT

**Worker side (`patreon-proxy.worker.js`):**
- New `POST /beta-updater-token` route. Body `{ patreonAccessToken }`. Verifies the caller's Patreon access token against `/oauth2/v2/identity`, applies the same Tier 3 / declined / owner-bypass rules as `patreon-auth.js`, returns `GITHUB_BETA_TOKEN` on success. 403 with `{error: "not_tier3", tier, email}` on demoted patrons. 502 on Patreon API errors.
- No new secrets needed — reuses the existing `GITHUB_BETA_TOKEN` already configured for `/beta-download/*`.
- See `scripts/deploy-worker-1.5.5.md` for the manual deploy walkthrough.

**SF side (`main.js`):**
- Beta auto-updater bootstrap is now async. On launch:
  1. Fetch fresh PAT from Worker (sends `patreonAuth.getRawAccessToken()`).
  2. On 200 → write PAT to `userData/beta-updater-token.txt` and use it.
  3. On 403 → wipe the cached file (patron demoted) and disable auto-update for this session.
  4. On network/5xx/404 → fall back to the cached PAT on disk if present.
  5. If neither fresh nor cached → disable auto-update for this session, same as before.
- Stable installs skip this whole flow.

### B. Aquilo Loadout dashboard (kit-side WIP)

**Protocol** (`LOADOUT-KIT.md`):
- Kit ships actions in the `Aquilo Streamer.Bot Kit` group with a sentinel action `Aquilo Loadout — Manifest`.
- SF calls `DoAction` on the manifest action; kit broadcasts a JSON descriptor (`source: "aquilo_loadout_manifest"`) describing widgets per loadout.
- Widget types in v1: `section` / `action` / `counter` / `toggle` / `chat-template` (plus auto-`loadout-switcher` when multiple loadouts exist).
- Click-handlers fire kit actions by id (or name fallback) via existing `_sbActionsCache`.
- Kit pushes state-deltas (`source: "aquilo_loadout_state"`) → SF surgically updates only touched widgets.
- Schema versioning + forward compatibility: SF skips unknown widget types so the kit can ship new ones without breaking older SF clients.

**SF side (`index.html`):**
- New toolbar `Loadout` button (auto-hides when no kit detected).
- Detection runs off the existing `_rfCheckActions` cache update path — kit's manifest action is matched on every SB connect.
- Widget renderer + dispatcher + state-delta merger.
- Loadout switcher (auto-renders as dropdown when `loadouts.length > 1`).
- Demo manifest at `scripts/loadout-demo-manifest.json` — SF's "Load demo manifest" button in the empty state renders a preview of the dashboard against the demo without needing a real kit installed. Useful for designing the real kit against a known-good payload.

### Verification

- Worker + main.js + index.html + new docs all parse cleanly.
- 25/25 auth-suite tests still pass.
- 16/16 Patreon entitlement tests still pass.
- 13/13 Loadout-dashboard wiring assertions pass (manifest handler, state delta, widget renderers, switcher, dispatcher).

### Known follow-ups

- Worker deploy required for the Worker-vended PAT path to actually fire (manual via Cloudflare dashboard — see scripts/deploy-worker-1.5.5.md).
- Aquilo Loadout SB kit itself (the kit ships separately; SF is ready when it does).
- Mouse4/Mouse5 hotbar binding Settings UI (still pending).

Co-Authored-By: Claude Opus 4.7 (1M context)
