# obs-overlays/ , migrated to aquilo.gg

As of 2026-06-09, the five OBS browser-source overlays no longer live
in this directory. They are hosted canonically at:

- https://aquilo.gg/sf/overlay/chat/
- https://aquilo.gg/sf/overlay/alerts/
- https://aquilo.gg/sf/overlay/shoutout/
- https://aquilo.gg/sf/overlay/vertical/
- https://aquilo.gg/sf/overlay/ticker/

Source files live in `aquilo-site/public/sf/overlay/` in the aquilo-site
repo. Edits land via the normal aquilo-site deploy; no StreamFusion
release is needed to ship an overlay change.

## What still happens in this repo

`obs-server.js` is unchanged in spirit , it still binds to
`127.0.0.1:8787` and broadcasts chat / alerts / config events over the
`/events` SSE stream. The only difference: requests for `/chat`,
`/alerts`, `/shoutout`, `/vertical`, `/ticker` now 302-redirect to the
aquilo.gg URLs. Existing OBS browser sources pointing at
`http://127.0.0.1:8787/chat` follow the redirect and keep working with
no streamer action required.

The aquilo.gg page (a static HTML overlay) opens an EventSource back
to `http://127.0.0.1:8787/events?type=<name>`. CORS on `/events` is
`*` so the cross-origin call works in OBS's embedded Chromium. The
hosted page also POSTs to `/api/integrations/register` so this app's
"Aquilo Products" panel surfaces each connected overlay.

## Why

Two reasons:

1. **Faster overlay iteration.** A typo fix or a new theme used to need
   a full StreamFusion build + release + auto-update cycle. Now it's
   `git push` to aquilo-site.
2. **Single source of truth.** The bundled and hosted copies kept
   drifting (sf-demo polish vs obs-overlays/chat.html). Centralizing on
   aquilo.gg ends that.

History of the deleted files is in git , `git log --diff-filter=D --
obs-overlays/chat.html` etc.
