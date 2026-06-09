# StreamFusion 1.12.0

A focused polish + emote-coverage release. The chat dock now renders
every Twitch ecosystem emote (Twitch native + 7TV + BTTV + FFZ, global
and per-channel), and the entire web surface (dock, customizer,
overlay landing page) got a head-to-toe visual refresh.

## What's new for you

### 🖼️ Full Twitch emote coverage in the chat dock

The StreamFusion Chat dock at
[aquilo.gg/dock/streamfusion-chat](https://aquilo.gg/dock/streamfusion-chat/)
now renders the entire Twitch emote ecosystem:

- **Twitch native** (Kappa, PogChamp, channel sub emotes, channel
  point emotes) , already flow through Streamer.bot's `parts` array;
  the renderer now fully respects them, including the per-emote
  `imageUrl` for sub-only emotes.
- **7TV global + channel set** , the broadcaster's installed 7TV
  emotes load when the dock learns the channel ID.
- **BetterTTV global + channel emotes** , both the broadcaster's
  channel set and any shared emotes.
- **FrankerFaceZ global + channel set** , the FFZ room emotes load
  alongside the others.

Channel-scoped sets auto-load when the dock learns the Twitch
broadcaster ID (from Streamer.bot's `GetBroadcaster` reply, or the
first event we see for older SB versions).

### ✨ End-to-end visual polish

- **Refined typography**: Inter as the system font with feature
  settings tuned for legible numbers (tabular nums in the stats grid).
- **Cohesive color tokens**: 8-step neutral ramp + calibrated platform
  accents, applied consistently across the dock, customizer, and
  overlay landing page.
- **Smoother motion**: every interaction uses a consistent ease
  (`cubic-bezier(0.22, 1, 0.36, 1)`); hover lifts, status pulses, and
  modal entries all share the same motion language.
- **Cleaner geometry**: tighter radii scale (4/6/8/12), consistent
  shadow tiers, refined hairlines.
- **Premium accents**: gradient lifts on Send / Copy / preset buttons
  with calibrated glow shadows; pulse animation on connection-status
  dots while connecting.
- **Better hierarchy**: refined section dividers, clearer label vs
  value contrast in the stats grid, accent-color hairlines on
  translated message lines.

### 🎛️ Dock polish details

- Brand mark is now a proper gradient chip (was a 9px square pixel).
- Status dots animate while connecting, glow steady when on.
- Stats cards have hover state, tabular numerals, smaller sparkline.
- Chat rows have refined animation on arrival, hover background,
  cleaner mod-action toolbar with backdrop blur.
- Compose Send button has gradient + glow shadow + hover lift.
- Settings sheet uses backdrop blur, smoother slide-in, clearer
  section headers, refined toggle switches with shadow.
- Toast notifications have a refined card style with slide-in.

### 🎨 Customizer polish details

- Topbar uses backdrop blur for depth.
- Preset buttons get a clear "selected" state with gradient + shadow.
- Demo controls are now a single grouped pill (Off/Slow/Normal/Fast)
  + fire chips separated by a hairline.
- Control sections have hover lift on the card border.
- Toggle switches updated to the same shadow + gradient pattern.
- Code values in URLs use a proper monospace stack and accent color
  pill.

## Under the hood

- `loadGlobalEmotes()` and `loadChannelEmotes(channelId)` , two
  separate fetches keep the API surface clean. Channel sets dedupe
  via `_channelEmotesLoaded` so reloading the same channel is cheap.
- `globalEmotes()` splits on whitespace so emote codes adjacent to
  punctuation still match cleanly.
- All polish lives in CSS; no JS changes were needed for the visual
  refresh. The shared token system means future tweaks happen in one
  place.

## Known follow-ups (not in this release)

- **Real Twitch broadcaster-customized badges** (sub / mod / VIP
  images from the channel's customized Twitch dashboard) still need
  a Helix proxy on SF's side. The chat overlay renders inline SVG
  glyphs (sword / heart / star / crown / diamond) in the meantime,
  which match the visual hierarchy and load instantly. Helix
  integration is queued for the next release.
- **`/dock/customize/` page** with theme presets is deferred. The
  dock's own Settings panel already exposes every knob; a separate
  customize page only pays off once we have a theme-presets system
  (Aurora / Minimal / Compact / High-contrast) to back it. Coming
  in 1.13.

## Migrating from 1.11.x

Nothing to do. All visual changes are CSS only and respect existing
cfg values. Emote sets auto-load on the next dock launch.
