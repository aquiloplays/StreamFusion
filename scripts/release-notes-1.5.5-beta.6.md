# StreamFusion 1.5.5-beta.6

## What's new for you

🪵 **Raid Finder action now logs every step to Streamer.bot's Logs tab.** When `Find Targets` doesn't sync your game or doesn't show streamers, open SB → **Logs** and you'll see exactly where it stopped (no Twitch creds, missing game ID, Helix returned 401, page-by-page scan counts, etc.) instead of having to guess from a silent timeout.

♻️ **Re-import in place — no more duplicate Raid Finder actions piling up.** The SBAE bundle's UUIDs are now sourced from SF itself, so the next time you import the actions Streamer.bot overwrites your existing copies in place rather than adding a second pair beside them. (Previous builds generated fresh random UUIDs, which created the duplicate-actions problem.)

**To pick up the change:**
1. Click `Raid` in StreamFusion → `Re-install Raid Finder actions` (or open the Install modal from the in-app message).
2. Copy the new import string and paste in Streamer.bot → Import → Import.
3. Click `Find Targets` again. If it still doesn't work, open SB → **Logs** and copy any `[SF rf v5]` lines so the failure mode is visible.

---

## Technical details

### Stable UUIDs across rebuilds

`scripts/build-rf-sbae.py` previously generated `uuid.uuid4()` for both top-level action UUIDs on every run. Streamers who re-imported after a SF update wound up with two pairs of identically-named actions (old broken + new working) sitting in the same SB group, and SB's DoAction-by-id resolution sometimes hit the stale copy.

Build script now reads `SF_RF_FIND_UUID` and `SF_RF_RAID_UUID` from `index.html` directly (the same hard-coded values SF's `_rfCheckActions` matches against), so the SBAE is reproducible and re-import always overwrites in place. Sub-action UUIDs are derived deterministically from the top UUID for full SBAE reproducibility.

### `[SF rf v5]` diagnostic logging

The Find Targets C# action now emits `CPH.LogInfo` / `CPH.LogWarn` calls at every step:

- **Entry**: `start reqId=X gameId=... gameName=... range=[...] want=N`
- **Twitch creds presence**: `clientId=len=N|EMPTY token=len=N|EMPTY` (lengths only — never logs the actual values)
- **Game-name → game-id resolution**: `/helix/games status=200`, resolved/unresolved
- **Pagination**: per-page `/helix/streams status=...`, `scanned-so-far`, `kept`, `sortedPast`, `hasCursor`
- **Helix failures**: status code + first 200 bytes of the error body
- **Final broadcast**: `streams=N scanned=N inRange=N`
- **Errors**: `BroadcastErr code=...` (twitch_not_connected | missing_gameId | helix_NNN)

Pure observability — no behaviour change to the happy path. Streamers who were silently hitting `twitch_not_connected` (because SB lost its Twitch login) or `helix_401` (token scope drift) will see it immediately instead of getting a generic "Search timed out" or "no streamers in your range".

### Notes

- Auth regression: 16/16 PASS.
- Bumped action label to `v5` in the log lines so it's obvious from a screenshot whether the streamer re-imported.
- The Start Raid action is unchanged.
