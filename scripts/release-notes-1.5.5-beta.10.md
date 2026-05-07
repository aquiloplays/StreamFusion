# StreamFusion 1.5.5-beta.10

## What's new for you

⚙️ **Loadout activity now lands in the events feed automatically.** Beta.7 added the `aquilo_loadout_event` receive-side, but only kits that explicitly broadcast outcome events surfaced rows — and most kits don't. Every time you click a Loadout widget, SF now adds a "&lt;Action&gt; fired" row to the events feed regardless of whether the kit broadcasts back. If a kit ALSO emits a kit-broadcast outcome (success / failure with detail), you get a second richer row — the two complement each other.

🧪 **Three more test triggers in Settings → Events:** `⚙️ Loadout fired` (mimics the auto-surfaced row), `⚙️ Loadout success` (kit-broadcast happy-path), and `⚙️ Loadout failure` (kit-broadcast failure-path). Lets you confirm every Loadout row format end-to-end without needing a real kit broadcast.

---

## Technical details

### Auto-surface in `_loadoutFireAction`

After the DoAction send succeeds, fires `addEvHistory('Loadout', label + ' fired', 'cc', false)`. `label` resolves from the widget spec's `name` / `actionName` so the row reads "Loadout — Cheer fired" rather than the underlying SB action's internal name.

Two-row design rationale: the auto-row says "I clicked this" (the streamer's action). A kit-broadcast `aquilo_loadout_event` row says "the side-effect ran" (the kit's report). Different concerns, different rows. Streamers running barebones kits see at least the click row; streamers running rich kits see both.

### Test triggers

`testEvent(kind)` gains three Loadout cases:

- `loadout-fired` — calls `addEvHistory` directly with the auto-surfaced shape (mimics what `_loadoutFireAction` now emits).
- `loadout-success` — calls `_loadoutHandleEvent` with a synthetic kit-broadcast payload (`result: 'success'`, with a `message`). Routes through the real handler so any future formatting changes there get tested too.
- `loadout-failure` — same but with `result: 'failure'`. Renders with the `✗` prefix + `failed —` lead-in.

UI: three new buttons in the existing test-trigger row in `Settings → Events → Test Triggers`, tinted amber to read distinct from the platform / rotation triggers.

### Notes

- Auth regression: 16/16 PASS.
- Backward-compatible. Kits that emit `aquilo_loadout_event` keep working — they just produce a SECOND row alongside the new auto-row. If that's noisy for your kit's setup, you can suppress the auto-row by short-circuiting in `_loadoutFireAction` (followup task if it bothers anyone).
