# StreamFusion 1.5.5-beta.7

## What's new for you

📋 **Aquilo Loadout actions can now report into the events feed.** When a Loadout SB-kit action runs (sound played, hotkey triggered, chat reply sent, etc.) the kit can now broadcast an outcome event that SF surfaces as a row in your events panel — even when the Loadout dashboard isn't open. Failures get a `✗` prefix and a "failed — &lt;reason&gt;" lead-in so they're scannable.

Tinted Crowd-Control orange so kit activity stays visually distinct from chat / platform events. Kit authors: see [`LOADOUT-KIT.md`](https://github.com/aquiloplays/StreamFusion/blob/main/LOADOUT-KIT.md#outcome-events) for the protocol spec — one new broadcast source (`aquilo_loadout_event`), additive only.

---

## Technical details

### New protocol channel

Adds a third broadcast `source` to the Loadout protocol, alongside the existing `aquilo_loadout_manifest` (full re-render) and `aquilo_loadout_state` (value deltas):

```jsonc
{
  "source":   "aquilo_loadout_event",
  "schema":   1,
  "widgetId": "snd_cheer",        // optional — links the row back to a widget
  "name":     "Cheer",            // human-readable label
  "result":   "success",          // "success" | "failure" | "info"
  "message":  "Played cheer.mp3", // optional detail
  "ts":       1764615555000       // optional
}
```

### SF receive-side

`handleSBEvent`'s `General.Custom` switch gains a third Loadout case after `aquilo_loadout_state`. The new `_loadoutHandleEvent(payload)`:

- Schema-gates with the same `schema > 1 → ignore` rule the manifest/state handlers use.
- Composes a row text: `<name> fired` for plain success, `<name> — <message>` when a detail is supplied, `✗ <name> failed — <message>` for `result === "failure" | "error" | "fail"`.
- Calls `addEvHistory('Loadout', text, 'cc', false)` — same path follows/subs/raids use, just tinted Crowd-Control orange.

State-delta channel (`aquilo_loadout_state`) is unchanged — that's still where value mutations happen. Outcome events are intentionally separate so a counter that ticks every second can update its widget (state delta) without spamming the events feed.

### Notes

- Auth regression: 16/16 PASS.
- Additive-only protocol change. Older kits that don't emit `aquilo_loadout_event` keep working unchanged; the new handler simply has nothing to route.
- Kit authors should reserve outcome events for "meaningful action ran" moments — they're permanent rows in the streamer's feed. Pair with `aquilo_loadout_state` when both apply.
