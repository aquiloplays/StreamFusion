# Aquilo Loadout — Streamer.Bot kit + StreamFusion dashboard

Protocol contract for the **Aquilo Loadout** Streamer.Bot kit. SF detects
the kit, reads its manifest, renders the dashboard. The kit handles all
the actual stream automation server-side; SF is the control surface.

> Generic Aquilo product registration lives in [INTEGRATIONS.md](INTEGRATIONS.md).
> This file is the kit-specific layer on top.

---

## TL;DR

1. The kit ships as a Streamer.Bot import bundle. All actions live in the
   group `Aquilo Streamer.Bot Kit`.
2. One sentinel action — **`Aquilo Loadout — Manifest`** — returns a JSON
   descriptor of the loadout when StreamFusion calls it. SF reads that
   manifest and builds a dashboard tab from it.
3. Every dashboard widget references a kit action by **id** (or name as
   fallback). When the user clicks a widget in SF, SF fires `DoAction` →
   the kit runs the action.
4. After the action finishes, the kit broadcasts state-deltas back via
   `CPH.WebsocketBroadcastJson` with `source === "aquilo_loadout_state"`.
   SF subscribes and re-renders only the touched widgets.

No `/api/integrations/register` call is required — SB-kit detection in SF
runs off `_rfCheckActions` group-name match (already shipped in 1.5.3).

---

## The manifest

The kit publishes its dashboard layout via the **`Aquilo Loadout —
Manifest`** SB action. SF calls `DoAction` on it; the action immediately
broadcasts the manifest as a `General.Custom` event:

```jsonc
// Broadcast payload (CPH.WebsocketBroadcastJson)
{
  "source":  "aquilo_loadout_manifest",
  "schema":  1,                       // bump if the wire shape ever changes
  "fetchedAt": 1764615555000,         // ms epoch — kit can refuse stale ones
  "kit": {
    "name":        "Aquilo Loadout",
    "version":     "0.1.0",
    "description": "Pre-built streamer dashboard kit",
    "accentColor": "#3A86FF",         // optional — themes the SF panel header
    "supportUrl":  "https://aquilo.gg/loadout"
  },

  // The streamer can have multiple loadouts ("Just Chatting", "Speedrun",
  // "Subathon" etc.); the kit tracks which is active. Switching is just
  // another action — see Loadout switching below.
  "activeLoadoutId": "default",

  "loadouts": [
    {
      "id":          "default",
      "name":        "Default",
      "description": "Standard streamer setup",
      "widgets": [
        // Visual section divider — every other widget references its
        // `id` via `section`. Order matters; SF renders top-to-bottom.
        { "id": "soundboard", "type": "section", "name": "Soundboard", "icon": "🔊" },

        // Plain action button — fires the kit action when clicked.
        // Either `actionId` (SB UUID, preferred — survives action renames)
        // or `actionName` (fallback). At least one must be present.
        {
          "id":         "snd_cheer",
          "type":       "action",
          "name":       "Cheer",
          "icon":       "🎉",
          "section":    "soundboard",
          "actionId":   "8a4f5b3c-...",
          "actionName": "Aquilo Loadout — Sound — Cheer",
          "args":       {}            // optional — passed to DoAction.args
        },

        { "id": "counters", "type": "section", "name": "Counters", "icon": "🔢" },

        // Counter widget — value display + ++ / -- / reset buttons.
        // SF tracks the current value locally + reflects state-deltas
        // pushed by the kit. Each button maps to a separate kit action.
        {
          "id":      "deaths",
          "type":    "counter",
          "name":    "Deaths",
          "value":   0,
          "section": "counters",
          "actions": {
            "increment": { "actionId": "...", "args": { "delta": 1 } },
            "decrement": { "actionId": "...", "args": { "delta": -1 } },
            "reset":     { "actionId": "..." }
          }
        },

        { "id": "modules", "type": "section", "name": "Modules", "icon": "⚙️" },

        // Toggle — boolean. Fires the action with `{ enabled: true|false }`.
        // SF reflects the current value via state-delta after fire.
        {
          "id":         "auto_so",
          "type":       "toggle",
          "name":       "Auto-shoutout raids",
          "value":      true,
          "section":    "modules",
          "actionId":   "...",
          "actionName": "Aquilo Loadout — Toggle — AutoSO"
        },

        { "id": "templates", "type": "section", "name": "Quick Messages", "icon": "💬" },

        // Chat template — fires an action that posts a chat message
        // (whatever the kit configured). SF treats it like a normal
        // action button visually but groups it under the templates
        // section so the streamer can find shorts fast.
        {
          "id":         "tpl_discord",
          "type":       "chat-template",
          "name":       "Discord",
          "preview":    "Join our Discord at https://discord.gg/...",
          "section":    "templates",
          "actionId":   "...",
          "actionName": "Aquilo Loadout — Template — Discord"
        }
      ]
    },
    {
      "id":   "speedrun",
      "name": "Speedrun",
      "description": "Stripped-down setup for runs",
      "widgets": [ /* ... */ ]
    }
  ]
}
```

### Schema versioning

Top-level `schema` is bumped only when the wire shape itself changes
(e.g. renaming a widget type). SF refuses to render manifests with
schema > the version it knows. Kit updates that *only* add new widget
types stay at the same schema number — SF gracefully skips unknown
types instead of bailing.

### Hot-reloading the manifest

Whenever the kit's loadout changes (loadout switched, new modules
enabled), it can re-broadcast a fresh manifest with the same shape;
SF replaces the cached copy and re-renders. Recommend: re-broadcast
after any action that materially changes the dashboard layout.

---

## Widget types (v1)

| `type`           | Visual                              | Kit action contract                               |
| ---------------- | ----------------------------------- | ------------------------------------------------- |
| `section`        | Header strip (name + icon, no clicks) | none                                              |
| `action`         | Single button                       | one action                                        |
| `counter`        | Number + ± and reset buttons        | three actions (`increment`/`decrement`/`reset`)   |
| `toggle`         | Switch with on/off label            | one action; receives `{ enabled: bool }`          |
| `chat-template`  | Button that visually hints "posts to chat" (with preview tooltip) | one action |
| `loadout-switcher` | (auto-rendered when `loadouts.length > 1`) | fires `Aquilo Loadout — Switch` with `{ loadoutId }` |

Future planned: `slider`, `select`, `text-input`, `progress-bar`,
`event-feed`, `media-preview`. Kits should set `schema: 1` until those
ship; SF skips unknowns silently so adding them is forward-compatible.

---

## Calling kit actions from SF

SF dispatches a widget click as a `DoAction` over the existing SB
WebSocket. Resolution order:

1. Match by `actionId` against `S._sbActionsCache` (already populated
   by `_rfCheckActions` for unrelated reasons — re-used).
2. Match by `actionName` if `actionId` missing or no match.
3. If neither resolves, surface a "this widget's action is missing —
   re-import the kit" error in the SF dashboard panel.

Click handler payload:

```js
S.sbWS.send(JSON.stringify({
  request: 'DoAction',
  id:      'sf-loadout-' + Date.now(),
  action:  { id: matchedAction.id, name: matchedAction.name },
  args:    Object.assign({}, widget.args || {}, runtimeArgs)
}));
```

`runtimeArgs` is widget-type-specific (e.g. `{ enabled }` for toggles,
`{ delta }` for counter ±, `{ loadoutId }` for switcher).

---

## State updates from the kit

Whenever a kit action mutates state SF should reflect, the action ends
with a broadcast:

```jsonc
{
  "source":   "aquilo_loadout_state",
  "schema":   1,
  "deltas":   [
    { "id": "deaths", "value": 5 },             // counter widget id
    { "id": "auto_so", "value": false }          // toggle widget id
  ]
}
```

SF subscribes to `General.Custom` events with that source and merges
deltas into the cached manifest. Only touched widgets re-render.

For full re-renders (e.g. loadout switched, manifest changed), the kit
re-broadcasts the manifest payload — SF replaces wholesale.

---

## Loadout switching

The kit ships a special action — **`Aquilo Loadout — Switch`** — that
takes `{ loadoutId: "..." }`. When SF's loadout-switcher widget fires
it, the kit:

1. Activates the requested loadout server-side (its own state).
2. Re-broadcasts the manifest with the new `activeLoadoutId` and the
   widgets array swapped to the new loadout's widgets.

SF replaces the cached manifest and re-renders the dashboard.

---

## Reserved action names + UUIDs

Kit ships these **stable** action UUIDs so SF can hard-detect:

| Action name                         | Purpose             | UUID (set at kit publish time) |
| ----------------------------------- | ------------------- | ------------------------------ |
| `Aquilo Loadout — Manifest`         | Manifest fetcher    | TBD                            |
| `Aquilo Loadout — Switch`           | Loadout switcher    | TBD                            |

SF's detection: scan `S._sbActionsCache` for the manifest action's
**name**; once found, fire it once on every SB connect to refresh the
cached manifest. UUIDs above can be added to the JS as constants once
the kit is published.

---

## Errors

If the manifest fetch:

- **times out** (15s, no broadcast received) → SF shows "Loadout kit
  installed but the manifest action didn't respond — re-import the
  kit" with an Install Kit button (existing SF→SB import flow).
- **returns invalid JSON / bad schema** → SF shows "Loadout kit
  manifest is malformed (schema X). Update SF or the kit." with the
  raw payload available via View Logs.
- **succeeds but action click fails** (action UUID not found) → that
  widget shows a `⚠ missing action` chip; other widgets stay live.

---

## Mock manifest for development

A static demo manifest lives at `scripts/loadout-demo-manifest.json`.
SF's Loadout panel has a "Load demo manifest" button (only shown in
dev mode) that renders the dashboard against the demo without needing
a real kit installed. Useful for:
- Building the SF rendering side before the kit is finalized.
- Letting the streamer preview the look without committing to install.
- Regression-testing widget rendering on SF changes.

---

## Versioning

Treat this contract as additive-only — same rule as `INTEGRATIONS.md`.
New optional widget fields are fine; never remove or repurpose an
existing field. SF v1.5.5 ships schema=1 support.
