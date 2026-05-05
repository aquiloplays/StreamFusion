# StreamFusion 1.5.5-beta.5

## What's new for you

🙅 **No more "@anonymous" / "Anon" rows.** Song-request events used to show a fake `@anonymous` (or `@viewer`) handle when the upstream chat source couldn't pin down a real username. Now those rows just read `♪ Queued: track` / `♪ Requested: track` instead — and the now-playing card / overlay strip stop showing `· req @anonymous` when no real requester is known.

🟢 **Spotify glyph instead of the purple "TW" chip.** Rotation song rows in the pop-out chat feed (and in the OBS chat overlay browser source) now render the Spotify wordmark on a green pill, not the Twitch purple `TW` badge that pre-1.5.5-beta.5 was reusing. Reads as music activity at a glance.

---

## Technical details

### Real-requester gate

Three formatters previously trusted `d.displayName || d.user || 'viewer'` and `d.requestedBy` directly, which surfaced the upstream chat sources' "anonymous" placeholder as if it were a real handle:

- `rotation-relay-client.js → chatRowForEvent` (OBS chat overlay system row)
- `index.html → onRotationEvent` (events history + pop-out chat feed)
- The `_npApplyRotationEvent` packet pushed to the pop-out's now-playing strip

All three now share a `_isRealRequester(s)` predicate — empty / `'anonymous'` / `'anon'` / `'viewer'` / `'someone'` are treated as "no real requester". When the predicate fails, the `@user` prefix is dropped entirely (rows read `♪ Queued: track — artist (#3)`) and the `· req @x` suffix on `Now playing` is omitted. The pop-out's `requestedBy` chip also gets stripped at send time so a stale placeholder doesn't bleed through.

`rotation.song.skipped` is unchanged — it never had a requester component.

### Rotation platform on the pop-out

`sendOverlayChat({ plat: 'tw', ... })` was the old mirror call — pre-1.5.5-beta.5 the pop-out painted rotation rows with the Twitch purple `.ov-pico.tw` chip + purple border. Tagged with the new `'rotation'` platform now; `overlay.html` adds:

- `.ov-msg.rotation { border-color: #1db954 }`
- `.ov-pico.rotation { background: #1db954; color: #000 }` (Spotify green)
- `.ov-user.rotation { color: #1db954 }`
- A Spotify wordmark SVG entry in the `_pSvg` icon map

### Rotation platform on the OBS chat overlay

`chat.html`'s `renderPlatIcon` was a 2-letter text label (`tw → 'TW'`, etc.) for known platforms with `plat.toUpperCase()` fallback for unknowns — `'rotation'` would have rendered as `'ROTATION'`. New short-circuit branch emits the same Spotify wordmark SVG inside `.pi.rotation`, which gets its own green-pill background. All other platforms unchanged.

### Notes

- Auth regression: 16/16 PASS.
- The upstream "anonymous" fallback in the Rotation widget's chat-sources/streamerbot.js stays put — kept as a safety net so a malformed SB event still has *some* value to thread through. SF just no longer trusts it as a display handle.
