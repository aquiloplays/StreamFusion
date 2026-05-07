# StreamFusion 1.5.5-beta.9

## What's new for you

🟣→🟢 **Final purge of the "TW" purple chip on song requests.** Rotation rows in the events feed now use a Spotify-green pill with the Spotify wordmark glyph on every surface — events panel, pop-out chat feed, OBS chat browser source, AND the OBS vertical bar. Pre-1.5.5-beta.9 some surfaces fell back to default platform styling on the `rotation` tag and surfaced as the generic chip.

🧪 **Test triggers in Settings → Events.** Sample-event buttons that fire a row through the real flow so you can confirm where it lands without waiting for a real follower to come in. Covers Twitch follow / sub / cheer / raid, TikTok gift, Kick sub, tip, plus three rotation flavors (`♪ Now playing`, `♪ Song queued`, `♪ Song skipped`).

⚡ **Vertical chat overlay lag fixed.** The 6-layer text-shadow stack from beta.4 (4 hard offsets + soft halo + currentColor glow) plus infinite gift-wobble + halo animations were the dominant cost on busy streams. Trimmed to a 3-layer text-shadow recipe; dropped the wobble + halo on vertical (the giftFloat drift is motion enough). Should feel smooth again on multi-bar bursts.

---

## Technical details

### Rotation = Spotify branding, ironclad

Three more places now match the platform-specific rotation handling that landed in 1.5.5-beta.5:

- `addEvHistory`'s `_evPlatSvgs` map gains a `rotation` entry (Spotify wordmark SVG). Was falling through to the generic music-note default.
- New `.ev-item.rotation` CSS rules: green border + green user color + green pico chip with dark glyph.
- `vertical.html` gets `.bar.rotation` (green accent + tinted username) and `.pi.rotation` (Spotify-green pill with the SVG glyph) plus the matching `renderPlatIcon` short-circuit. Pre-1.5.5-beta.9 the vertical overlay rendered `<span class="pi rotation">ROTATION</span>` text + a generic accent.

The rotation event handler also switched its events-history `color` arg from `'se'` (StreamElements green) to `'rotation'` so the row picks up the new branded styling directly instead of looking like a Streamlabs tip.

### Vertical overlay lag triage

Before/after on the per-bar paint cost:

| Element | Pre-beta.9 | Now |
| --- | --- | --- |
| `.user` text-shadow | 4 hard offsets + soft halo + currentColor glow (6 layers) | 2 diagonal hard offsets + soft halo (3 layers) |
| `.text` text-shadow | 6 layers same recipe | 3 layers |
| `.sep` text-shadow | 5 layers | 3 layers |
| `.gift .g-art` | infinite `giftWobble` (rotate + scale) | none — drift carries the motion |
| `.gift .g-art::before` | infinite `giftHalo` (radial gradient pulse) | removed; img drop-shadow keeps the visual weight |

Plus `contain: layout paint style` on `.bar` to isolate per-bar repaints. On a sub-bomb (10 bars cycling in / out at once with a marquee on each), this stops a single marquee scroll from invalidating the rest of the page.

The horizontal chat overlay (`chat.html`) keeps the wobble + halo — its larger canvas / sparser gift cadence absorbs the cost without dropping frames.

### Test triggers

New `testEvent(kind)` function wired to a row of buttons in `Settings → Events → Test Triggers`. Each button calls `addEvHistory(user, text, plat, big, ...)` with a synthetic payload — same path real events take. Rotation triggers also call `_npApplyRotationEvent` so the now-playing bar updates too.

### Notes

- Auth regression: 16/16 PASS.
- Backward-compatible. Existing rotation messages still flow through the same channels — they just paint Spotify-branded now. No protocol change.
- The horizontal chat overlay was already Spotify-branded; only vertical + the events feed needed catch-up.
