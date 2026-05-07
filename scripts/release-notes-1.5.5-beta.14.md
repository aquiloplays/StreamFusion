# StreamFusion 1.5.5-beta.14

## What's new for you

🪟 **OBS auto-refresh now tells you whether it worked.** Settings → OBS Overlays → "Auto-refresh OBS browser sources" gets a status line under the manual-refresh button: `✓ Refreshed 3 SF browser sources · 12s ago`, or specific failure reasons (`OBS not detected on port 4455`, `Auth required — paste OBS WS password above`, `Connected to OBS, but no SF browser sources detected`). No more wondering whether the wiring is alive.

🧹 **Loadout events stop double-rowing.** Pre-beta.14 a Loadout widget click would fire BOTH the auto-surfaced "Action fired" row AND a kit-broadcast outcome row when the kit emitted `aquilo_loadout_event`. The auto-row now gets removed when a kit broadcast for the same `widgetId` arrives within 2s — the richer kit row replaces it. Kits without broadcasts still get the auto-row (no behavior change there).

📺 **Ticker test trigger.** `Settings → Events → Test Triggers` gets a 📺 Ticker chat msg button that fires a sample chat message through the same broadcast pipe real chat uses. Lands in chat / vertical / ticker overlay browser sources at once — confirming the new ticker overlay is wired correctly without waiting for a real msg.

---

## Technical details

### OBS refresh outcome tracking

`main.js` adds module-level `_lastObsRefresh = { outcome, matches, at, message }` populated at every key step in `refreshObsBrowserSources`:

- ECONNREFUSED on the WS connection → `outcome: 'no_obs'`
- Hello with `authentication` field but no stored password → `outcome: 'auth_required'`
- Identified + GetInputList completes with N matches → `outcome: 'success', matches: N`
- Identified but zero browser sources matched the SF loopback regex → still `'success'` but `matches: 0` with a hint about adding overlay URLs to OBS
- Other ws / parse errors → `outcome: 'error', message: <detail>`

`obs-refresh-cfg-get` IPC returns `last: _lastObsRefresh` alongside the existing fields. Renderer `_hydrateObsRefreshCfg` renders a colored status line based on the outcome. Manual refresh re-hydrates after 800ms so the fresh outcome lands.

### Loadout dedup

New `_loadoutAutoRows = new Map()` keyed by `widgetId` → `{ el, ts }`. `_loadoutFireAction` records the freshly-added row (DOM ref via `feed.firstElementChild` immediately after the addEvHistory call) into the map and schedules an auto-evict 2.5s later. `_loadoutHandleEvent` looks up the kit broadcast's `payload.widgetId` first thing — if a recent auto-row entry exists within 2s, removes the auto-row from the DOM and deletes the map entry.

Counter +/- sub-actions don't dedup (their `spec.id` is the sub-action UUID, not the parent counter widget's id) — kit-broadcast outcomes for counters still surface alongside the auto-row. Acceptable: a +/- click and "value changed" outcome are arguably distinct events anyway.

### Ticker test trigger

New `'ticker-chat'` case in `testEvent(kind)` calls `electronAPI.obsBroadcastChat(...)` with sample data. `main.js`'s `obs-broadcast-chat` handler already fans out to `['chat', 'vertical', 'ticker']`, so the test message lands in all three overlay browser sources (and the pop-out via the existing chat-mirror path). Single button at the end of the existing test-trigger row.

### Notes

- Auth regression: 16/16 PASS.
- Memory file `reference_streamfusion_build.md` updated separately — the pre-1.5.5 PAT-rotation note was for the old curl-based release workflow; we've used `gh release create` for 14 betas without ever needing one.
