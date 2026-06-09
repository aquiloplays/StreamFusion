# StreamFusion 1.10.0

The big one: **overlay customization moved entirely to the web**. Plus an
editable hotkey UI, six chat overlay presets, and live settings sync.

## What's new for you

### 🎨 Overlay customization on aquilo.gg

The Settings, OBS Overlays pane is gone. Every knob, theme, fonts,
colors, animations, presets, TikTok gift placement, all of it, lives
at **[aquilo.gg/sf/customize](https://aquilo.gg/sf/customize/)** now.

The customizer page connects directly to your local StreamFusion (it
pings 127.0.0.1:8787 through 8791) and pushes changes live. There's a
side-by-side iframe preview so you can see exactly what OBS will see
while you tweak. Changes save to a JSON file in your SF user data, so a
restart restores your exact look without you reopening the customizer.

Why move it out of the app? Two reasons:

1. **Faster iteration.** A typo fix or a new theme used to need a full
   StreamFusion build, release, and auto-update cycle. Now it's a git
   push to aquilo-site.
2. **Single source of truth.** No more bundled vs hosted overlay drift.

Your existing overlay settings carry over automatically on first boot,
nothing to reconfigure. The Settings, OBS Overlays tab now shows a
purple CTA card pointing at the customizer plus the five browser source
URLs with copy buttons.

### 🌐 OBS overlays now hosted on aquilo.gg

The five browser source overlays (chat feed, alerts banner, shoutout
card, vertical bar, horizontal ticker) are now served from
[aquilo.gg/sf/overlay/](https://aquilo.gg/sf/overlay/). Your existing
`http://127.0.0.1:8787/chat` URLs in OBS keep working, they 302-redirect
to the hosted versions. Nothing to re-paste.

The hosted page connects back to your local StreamFusion's `/events`
SSE stream for chat + events, so the data path is unchanged. Just the
HTML lives somewhere else now.

### 🎛️ Six chat overlay presets

The customizer ships with six starter looks for the chat overlay:

- **Aurora**, the Aquilo default. Cosmic dark base with violet/teal
  accents.
- **Minimal**, just text. No avatars, no badges, no chrome.
- **Glassy**, frosted-glass panel with soft cyan accents.
- **Neon**, cyan text-shadow with slide-left entrance animation.
- **Classic Twitch**, the look most viewers already know.
- **Vintage Console**, green-on-black monospace terminal vibes.

Click one, every knob updates at once, your overlay re-styles live. Use
them as a starting point and tweak from there.

### ⌨️ Editable hotkey UI

Settings, Hotkeys is now a proper editor: each row has a capture widget
that listens for your key combo (including `F13`-`F24`, `Ctrl+Shift+X`,
mouse buttons), saves automatically, and warns inline if you pick a
combo that's already bound elsewhere.

Combine with hotbar slot hotkeys (added in 1.5.5) and you can drive most
of StreamFusion from a streamdeck or programmable mouse without ever
touching the app window.

### 💾 Boot config sync

Whenever you restart SF, the overlay server's in-memory config used to
start empty, your browser sources would fall back to defaults until you
touched a setting in the UI. Now, your saved cfg pushes once the server
binds, so the overlay restores its exact look immediately. No more
"why did my chat overlay reset" moment after an auto-update.

## Under the hood

- `obs-server.js` exposes three new endpoints, `GET /api/config`,
  `GET /api/config/<overlay>`, and `POST /api/config/<overlay>`. The
  customizer page writes through these; the existing `/events` SSE
  stream broadcasts the cfg change to every connected browser source.
- Per-overlay cfg is persisted to `userData/obs-config.json` with a
  debounced (250ms) writer so dragging a slider doesn't hammer the
  disk. Loaded on `startServer` boot.
- The `obs-overlays/*.html` files were deleted from this repo. Source
  lives in `aquilo-site/public/sf/overlay/`. A `MIGRATED.md` breadcrumb
  is left in the dir for anyone landing there from a stale clone.

## Migrating from 1.9.x

Nothing to do. Your existing overlay settings copy over automatically
on first boot of 1.10.0. The Settings, OBS Overlays pane gets the new
CTA, your browser source URLs in OBS keep working.

## Known limitations

- The customizer is a web page, so it needs internet to load. Once it's
  open it talks only to your localhost, no telemetry, no server roundtrip
  for the actual config writes.
- The web preview iframe shows what OBS will see; pop-out windows and
  the in-app chat dock are unaffected and unchanged.
