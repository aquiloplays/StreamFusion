# StreamFusion 1.5.5-beta.4

## What's new for you

🔤 **Vertical chat overlay reads cleanly on bright scenes.** The transparent-bar treatment from earlier in 1.5.5 looked great on dark scenes but got swallowed by bright backgrounds. Body text now uses a sharper outline + a slightly heavier weight so messages stay legible without needing a chat-box panel behind them.

🎁 **TikTok gifts drift right next to your chat.** Previously the gift float zone sat in the top 50vh while the chat bar sits at the bottom — gifts felt disconnected from the comment that mentioned them. Now anchored to a band immediately above the chat bar so a gift drifts past the most recent message.

---

## Technical details

### Vertical overlay legibility

Replaced the single soft-blur `text-shadow: 0 2px 6px rgba(0,0,0,.5/.7)` recipe on `.user`, `.text`, and `.sep` with the standard streaming-overlay outline stack — four 1px hard offsets (`-1px -1px 0`, `1px -1px 0`, `-1px 1px 0`, `1px 1px 0` at `rgba(0,0,0,.95)`) plus a `0 0 8px` soft blur. Username keeps its existing `0 0 14px currentColor` platform-tint glow on top of the outline. `.text` also bumps `font-weight: 600` (was inherited 400) — the body of a chat message is the part that gets swallowed first when text-shadow alone is doing the heavy lifting.

### TikTok gift band reposition

`#gifts` was `position: fixed; top: 0; left: 0; right: 0; height: 50vh` — top half of the canvas. Changed to `bottom: 110px; height: 40vh; top: auto`, anchoring the band just above where `#stage` (`inset: auto 0 0 0`) renders the chat bar. The existing horizontal-drift keyframes (`giftFloat` — `translate(60px → -100vw)` plus a `5vh` `--drift-y`) continue to work without modification; gifts now drift across this lower band, ending near the chat bar's vertical position.

### Notes

- Auth regression: 16/16 PASS.
- Horizontal chat overlay (`chat.html`) is unchanged — the 1.5.5-beta.2 side-column gift placement options + box themes remain.
- `.bar::before` (the 4px platform-tinted left accent) stays — it's the only visual chrome remaining in vertical, an intentional minimal cue for which platform a message came from.
