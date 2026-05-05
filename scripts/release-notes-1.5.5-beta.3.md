# StreamFusion 1.5.5-beta.3

## What's new for you

🎤 **Requester shown on the now-playing bar.** When a viewer's `!sr` becomes the current track, you'll see an `@username` chip on the now-playing bar (and on the pop-out's strip) so you know at a glance who to thank.

🔕 **Pop-out big-event banner moved out of chat.** Raids, hype level-ups, and big tip celebrations no longer pop up screen-center over the chat feed in your pop-out. They now slide down from the top of the window — chat stays readable underneath.

🎵 **Single events-history row per song event.** Previously every `rotation.song.*` event landed twice in the events history (once as a "StreamFusion" status row, once as the rich `♪ Now playing` row with album art). Cleaned up — just the rich row now.

---

## Technical details

### Requester chip on now-playing bar

- New `.np-req` element on the main app's `#npBar`, mirroring the pop-out's existing `.ov-np-req`. Spotify-green pill, max-width 140px, ellipsis on overflow.
- `_npState.requestedBy` field added; populated from both data paths:
  - **Heartbeat meta**: the Rotation widget's `streamfusion-link.js` already includes `requestedBy` in its meta payload (sourced from `request-queue.js`'s `markPlayingIfMatched`).
  - **Cloud relay**: `_npApplyRotationEvent` reads `d.requestedBy` from the `rotation.song.playing` event payload.
- Both paths overwrite the field unconditionally on each update — when the next track is auto-DJ'd (no requester), the chip clears rather than clinging to the previous value.
- `_npPushToOverlay` propagates `requestedBy` to the pop-out so its existing chip stays in sync between heartbeats and relay events.

### Duplicate events-history row eliminated

Previously the rotation event handler in `index.html` did:

1. `sysMsg('tw', oneLine)` — which resolves to `addEvHistory('StreamFusion', oneLine, 'tw')`.
2. `addEvHistory(name, text, color, isPinned, null, '', avatar)` — the rich variant with album art for now-playing rows.

Both landed in the events history. Removed (1); kept (2). Comment retained explaining the historical reason for both calls.

### Pop-out banner repositioned

`.ov-banner` was `position: fixed; top: 50%; transform: translateY(-50%)` — screen-centered. Replaced with `top: 64px` (slots in just below the drag handle + live-bar) and removed the centering transform. `ovBnrIn` and `ovBnrOut` keyframes rebuilt to slide down from above for entry / slide back up + fade for exit, preserving the pop-in overshoot + horizontal jiggle.

The full-screen `.ov-raid` and `#ovHypeLevelUp` overlays (rare, brief, intentional celebratory takeovers) are unchanged.

### Notes

- Auth regression: 16/16 PASS.
- Additive-only protocol changes; older Aquilo Spotify Widget builds keep working.
