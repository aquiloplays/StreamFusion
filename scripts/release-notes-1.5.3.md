## What's new for you

**Raid Finder actually works now.** The actions shipped in 1.2.5 silently failed to compile inside Streamer.bot because they were missing some required references — every search just hit the 15-second timeout. Open the Raid Finder, click "Re-install actions", **delete your old `StreamFusion Raid Finder` actions in SB first**, then paste the new import string. New action UUIDs ensure SF will pick the working copy even if you forget to delete the old one.

**Outgoing Raid Scheduler.** New clock button on each Raid Finder result lets you schedule a raid for 5/10/15/30/45/60 minutes from now (or a custom number). A live countdown chip appears on the toolbar Raid button and inside the panel. You can fire-now or cancel any time. Schedule survives an SF restart.

**Smart Shoutout Queue.** New **Shoutouts** button in the toolbar. When a fellow Twitch streamer chats in your channel, they auto-queue here with their current game — one click sends `/shoutout`. There's an auto-fire toggle if you want it hands-free, plus a customizable command template (default `/shoutout {target}`) and an exclude list (defaults skip the common chat bots). Resets every stream so a regular gets re-detected fresh.

**Discord live-announce + auto-recall.** Settings → Integrations → Discord Live-Announce. When you go live, SF posts a "🔴 Live now" message to your existing Discord recap webhook with your title, game, and Twitch URL. When the stream ends, the same message edits to a "stream ended" recap, deletes itself, or stays — your choice. Optional role-ping on go-live; auto-mentions are sandboxed so a templating accident can't @everyone you. Test button included.

**Big chat widget revamp.** The Box style is now a proper gradient frame instead of a flat grey rectangle, and **the box height auto-sizes to your "Max messages on screen" setting** — so a quiet channel doesn't show a giant empty panel. Messages no longer clip outside the frame during animations. New **Box (no background)** style for streamers who want the transcript look on a transparent overlay (or layered over a custom OBS background). Card style is unchanged.

**Aquilo Products panel** (Settings → Integrations). Companion products from aquilo.gg show up here when they're running — currently a placeholder for the upcoming **Aquilo Spotify Widget** and **Aquilo Streamer.Bot Kit**. Auto-detects, no setup.

---

## Technical details

### A. Raid Finder fix (the actual bug)

**Root cause:** the embedded SBAE action only referenced `mscorlib.dll`, but the C# uses `System.Linq` (needs `System.Core`), `HttpClient` (needs `System.Net.Http`), and `Newtonsoft.Json.Linq` (needs `Newtonsoft.Json.dll`). SB silently failed to compile, so DoAction returned `ok` but no broadcast ever fired → 15-second renderer timeout.

- New `SF_RF_IMPORT` blob with `[mscorlib + System + System.Core + System.Net.Http + Newtonsoft.Json]` on Find Targets and `[mscorlib + System]` on Start Raid.
- Action UUIDs bumped to fresh values (`SF_RF_FIND_UUID` / `SF_RF_RAID_UUID` constants in JS) so re-import doesn't conflict with the broken copy.
- `_rfCheckActions` now matches by UUID first, falls back to name-match — even if the streamer doesn't delete the old action, the working one wins.
- Install-modal "Already imported before? Delete the old ones first" callout above the import string.
- Timeout error now offers a "Re-install the Raid Finder actions" link.
- New `scripts/build-rf-sbae.py` regenerates the SBAE blob with verified round-trip; `scripts/decode-sbae.py` extracts the JSON + embedded C# for diffing.

### B. Outgoing Raid Scheduler

- `S.raidFinder.scheduled = { login, displayName, fireAt }` persisted via `saveSettings`. On startup, if `fireAt` is in the future the timer re-arms; stale schedules are silently dropped.
- Per-result clock button → modal picker (5/10/15/30/45/60 + custom 1-240 min).
- Active-schedule banner at the top of the Raid Finder panel with live-tick countdown + Fire Now + Cancel.
- Toolbar Raid button gets an inline countdown chip (`mm:ss`) that ticks every second. Both surfaces share one tick timer.
- `_rfStartRaid` refactored to take `opts.skipConfirm` so scheduled fires don't re-prompt.

### C. Smart Shoutout Queue (Tier 2 EA)

- New toolbar button with red badge counter, `i-megaphone` icon.
- Hooks `Twitch.ChatMessage` handler — fires `decapi.me/twitch/uptime/{login}` per new chatter, falls back to "live" detection if response doesn't contain "is offline" / "not found".
- On live detection, fires `decapi.me/twitch/game/{login}` to enrich the queue entry. Per-stream-session dedup so each chatter is checked once per stream.
- Skips: broadcaster, `*bot$` patterns, configurable exclude list.
- Manual fire routes through existing `quickShoutout` helper for `/shoutout`-prefixed templates (preserves the 2-min cooldown). Custom templates send as raw chat.
- Settings → Integrations → Smart Shoutouts: enable, auto-fire, command template, exclude list.

### D. Discord Live-Announce + Auto-Recall (Tier 2 EA)

- Reuses the existing `discordWebhook` field — same channel as the recap.
- `_discordAnnounceFireGoLive` runs from `startStreamSession`. POSTs with `?wait=true` to capture the returned message id. Pre-fetches stream title via `decapi.me/twitch/title/{login}`. Templates: `{streamer} {game} {title} {url} {role}`.
- `_discordAnnounceFireGoOffline` runs from `endStreamSession`. PATCH for edit, DELETE for delete, or no-op for keep. End template gets `{duration}`. Snapshot-then-clear pattern so live-monitor flap can't double-attempt against a deleted message.
- `allowed_mentions` is locked: either `{ parse: [] }` or `{ parse: [], roles: [<id>] }` — no @everyone/@here possible from a templated accident.
- Runtime state deliberately not persisted. SF restart mid-stream means the next end-event silently skips the recall instead of trying to PATCH a stale id.

### E. Chat overlay (`obs-overlays/chat.html`)

- `theme-box`: linear-gradient overlay (brand blue/teal twist over the existing translucent dark base) replaces the flat translucent rectangle. Soft drop-shadow.
- `max-height` removed in favour of auto-size with a `95vh` safety cap. Box height = message count; `maxMessages` setting becomes the de-facto height limit.
- `overflow:hidden` retained so leaving-animation clipping happens against the gradient frame, not the OBS source edge — messages can never appear *outside* the box.
- New `theme-nobg`: same auto-size, transparent feed, flat per-message rendering with thin platform-tinted left borders.
- Settings → OBS Overlays → Chat → Style picker: *Card / Box (gradient) / Box (no background)*.

### F. Aquilo product integration surface

`obs-server.js` now hosts a small REST + SSE registry under `/api/integrations/*`. CORS-open, loopback-bound, no auth besides 127.0.0.1.

```
POST /api/integrations/register    {product, version, capabilities, port?, urls?, meta?}
                                   -> {ok, clientId, heartbeatMs}
POST /api/integrations/heartbeat   {clientId, meta?}
POST /api/integrations/unregister  {clientId}
GET  /api/integrations/list        -> {products: [...]}
GET  /api/integrations/events      SSE: hello + registered/unregistered
```

- Stale-prune on each 25s heartbeat tick (drops entries silent >60s).
- Pure in-memory; every product re-registers on its own restart or SF restart.
- Streamer.Bot kit detected via existing `_rfCheckActions` action cache (`group === "Aquilo Streamer.Bot Kit"`) — no HTTP registration needed.
- Reserved product IDs: `aquilo-spotify-widget`, `aquilo-sb-kit`. Unknown products render generically.
- Full protocol contract in `INTEGRATIONS.md` at the repo root.

### Verification

- `node scripts/test-auth-suite.js` — 25/25 pass.
- `node scripts/test-patreon-entitlement.js` — 16/16 pass.
- SBAE end-to-end round-trip verified.

### Known follow-ups

- Mouse4/Mouse5 hotbar binding Settings UI (IPC wired in `preload.js`, no picker built).
- Cloudflare Worker-vended auto-updater PAT for Tier 3 patrons.
