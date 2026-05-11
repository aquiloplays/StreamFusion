# StreamFusion 1.6.3

## What's new for you

🚫 **Profanity filter for chat overlays.** New toggle in **Settings → OBS Overlays → Chat overlay filter** replaces common curse words with asterisks on chat messages going to your OBS overlays and pop-out. Your main chat panel keeps the raw text so you + your mods still see what was said — only on-stream surfaces get filtered.

Default off (existing streams keep current behaviour). Word-boundary matching covers ~40 common stems. Family-friendly streams, platforms with stricter content rules, or just personal preference — flip it on and the next chat message hits the overlays scrubbed.

---

## Technical details

### Wordlist + matcher

`_profanityList` in `index.html` — ~40 common English stems with their typical conjugations (`fuck`/`fucking`/`fucker`/`motherfucker`, etc.). Sorted longest-first so the regex alternation matches the longer form before the shorter (regex left-to-right behavior). Compiled once at script load as `_profanityRegex` with `\b(...)\b` word boundaries and the `gi` flags.

```js
function _filterProfanity(text) {
  if (!filterChatProfanity || !text || typeof text !== 'string') return text;
  return text.replace(_profanityRegex, function(match) {
    return '*'.repeat(match.length);
  });
}
```

Asterisk replacement preserves length so marquee timing on the vertical bar, ticker scroll cadence, and chat-card layout stay the same.

### Where it hooks in

`sendOverlayChat(m)` filters BOTH `m.text` and `m.html` when the setting is on, then passes through to `sendToOverlay({ type: 'chat' })` (the pop-out IPC) and `sendObsChat(m)` (the OBS browser-source SSE broadcast). The filter runs ONCE on the way out — every overlay variant downstream sees the same scrubbed text.

The mutation of `m.text` / `m.html` is safe because the chat-panel renderer (`addMsg`) uses those fields before calling `sendOverlayChat` — main app's view is unaffected.

### Setting

`filterChatProfanity` (bool, default `false`) persisted in the existing `sf_settings` localStorage blob alongside `showAvatars` / `showNowPlaying` / etc. Bootstrap restore in the same IIFE that hydrates the other new UI elements.

### Notes

- Auth regression: 16/16 PASS.
- Streamers wanting stricter / different wordlists run a Streamer.bot or chatmod tool upstream — this is a moderate built-in filter, not a replacement for a full moderation pipeline.
- Emote names virtually never contain curse words in word-boundary form, so emote rendering in the pop-out's html path is unaffected in practice.
