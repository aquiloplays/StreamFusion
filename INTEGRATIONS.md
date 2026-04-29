# Aquilo product integration protocol

How the **Aquilo Spotify song widget**, **Aquilo Streamer.Bot kit**, and
future Aquilo products plug into a running StreamFusion instance.

The streamer sees connected products in `Settings → Integrations → Aquilo
Products`. Detection is opt-in and best-effort — SF does not require any
companion product to function.

---

## TL;DR

- StreamFusion runs a localhost HTTP server (`obs-server.js`) bound to
  `127.0.0.1` on a configurable port (default **8787**, exposed by SF in
  the OBS-overlay settings as the same URL the streamer copies into OBS).
- That server exposes a small REST + SSE surface under `/api/integrations/*`.
- A companion product `POST /api/integrations/register` on startup, then
  heartbeats every ≤30s.
- StreamFusion's renderer subscribes to `/api/integrations/events` and
  shows the product card live in the settings panel.
- All endpoints are CORS-open (`*`) so a widget hosted on
  `widgets.aquilo.gg` can talk to `127.0.0.1:8787` from a browser source.

---

## Endpoints

Base URL: `http://127.0.0.1:<port>` — the port is whatever the streamer
set in StreamFusion (`/ping` returns the live port).

### `GET /ping`
Always 200, no auth. Use this to confirm SF is running.
```json
{ "ok": true, "entitled": true, "port": 8787 }
```

### `POST /api/integrations/register`
Send your product info. Response gives back a `clientId` you pass on every
subsequent call.
```jsonc
// request
{
  "product":      "aquilo-spotify-widget",
  "version":      "0.3.1",
  "capabilities": ["now-playing", "song-changed", "request-skip"],
  "port":         9090,                  // optional — if your widget hosts its own server
  "urls": {                              // optional — quick links surfaced in SF UI
    "settings": "http://127.0.0.1:9090/settings",
    "overlay":  "http://127.0.0.1:9090/overlay"
  },
  "meta": { "spotifyAccount": "user@example.com" }   // arbitrary, shown as small text in SF UI
}
// response
{ "ok": true, "clientId": "sf-int-mh2x9-3", "heartbeatMs": 30000 }
```

### `POST /api/integrations/heartbeat`
Call this every `heartbeatMs / 2` (so 15s by default). After 60s of
silence your entry is auto-pruned.
```jsonc
{
  "clientId": "sf-int-mh2x9-3",
  "meta": { "track": "Song name", "artist": "...", "albumArt": "..." }   // optional updates
}
```

### `POST /api/integrations/unregister`
Best-effort cleanup on graceful shutdown.
```jsonc
{ "clientId": "sf-int-mh2x9-3" }
```

### `GET /api/integrations/list`
Snapshot of currently-connected products. Used by SF UI on tab open.
```json
{ "products": [ /* see register response shape */ ] }
```

### `GET /api/integrations/events` (Server-Sent Events)
Live stream of `registered` / `unregistered` events for SF UI to react to.

---

## Reserved product names

When you ship, please use one of these stable identifiers so SF can render
the right icon / colour:

| `product`                    | What it is                              |
| ---------------------------- | --------------------------------------- |
| `aquilo-spotify-widget`      | The Spotify song widget                 |
| `aquilo-sb-kit`              | The Streamer.Bot kit (see below)        |

Anything else is shown generically.

---

## Streamer.Bot kit detection

The SB kit is special because it's not a separate process — it's a bundle
of SB actions imported into the streamer's Streamer.Bot.

SF detects the kit by querying `GetActions` over the existing SB
WebSocket connection and matching:

- **Group name:** `Aquilo Streamer.Bot Kit`
- **Action UUID prefix:** any (matched by name)

If the kit is detected, SF surfaces it in the same Aquilo Products panel
with the list of installed actions and their version (read from a sentinel
action named `Aquilo Kit — Version Sentinel` whose description is the
version string).

The kit doesn't need to call `/api/integrations/register` — SF's SB
detection is the registration path.

---

## Capability vocabulary

Free-form strings, but please reuse these where they fit:

| Capability        | Meaning                                                   |
| ----------------- | --------------------------------------------------------- |
| `now-playing`     | Pushes "current song" updates via heartbeat `meta`        |
| `song-changed`    | Will trigger a custom event when track changes            |
| `request-skip`    | Accepts a skip request from SF (chat command bridge)      |
| `chat-bridge`     | Wants to receive chat events from SF (e.g. !song)         |
| `overlay-source`  | Hosts a browser-source URL that goes into OBS             |
| `obs-control`     | Can drive OBS scenes / sources                            |

---

## Mixed-content gotcha (HTTPS widgets → HTTP loopback)

If your widget HTML is served over **HTTPS** (e.g.
`widgets.aquilo.gg/spotify`), browsers may block its `fetch()` calls to
`http://127.0.0.1:8787`. Two paths around this:

1. **Initiate from SF:** SF can poll `widgets.aquilo.gg` (HTTPS → HTTPS,
   safe) for status, and the widget POSTs to SF only from contexts that
   allow it (Electron CEF, standalone Node).
2. **Serve the widget over HTTP loopback too:** OBS browser sources do
   not enforce mixed-content as aggressively as a standard browser. If
   the widget runs as a local Electron app or a local HTTP server it can
   register against SF freely.

For the Spotify widget specifically: if it's a hosted page on
`widgets.aquilo.gg` that the streamer drops into OBS as a browser source,
it should call `/api/integrations/register` from inside that same browser
source (which is OBS's CEF, not a hardened browser) — and the streamer's
SF will pick it up.

---

## Versioning

Treat this contract as additive-only. New optional fields are fine; never
remove or repurpose an existing field. SF v1.5.3 ships endpoint v1.
