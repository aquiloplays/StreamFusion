# StreamFusion 1.5.5-beta.8

## What's new for you

🖱️ **Per-hotbar-slot keyboard hotkeys.** Each hotbar action can now bind any global accelerator — `F13`, `Ctrl+Shift+1`, `Alt+Q`, `Mouse4`, `Mouse5`, etc. The combo fires the slot from anywhere on your machine, even when StreamFusion isn't focused.

⌨️ **Capture button (⌨) next to each slot's hotkey input.** Click it, then press the combo (or click your side-mouse button). SF detects it and saves automatically. Esc cancels.

### 6+ button mouse setup

Windows only natively distinguishes Mouse4 (XB1) and Mouse5 (XB2) — those two are bindable directly. For additional buttons, open your mouse software (Logitech G HUB, Razer Synapse, Corsair iCUE, etc.) and map each physical button to a unique combo. **Recommendation: F13–F18.** Those are real keyboard keys nothing else uses, so they won't collide with games or other apps. Then bind those F-keys to hotbar slots in SF.

A 6-button mouse becomes:

| Mouse button | Mapped to (in mouse software) | Bound in SF |
|---|---|---|
| Side back | (default — emits Mouse4) | Mouse4 → hotbar slot 0 |
| Side forward | (default — emits Mouse5) | Mouse5 → hotbar slot 1 |
| Thumb 1 | F13 | F13 → hotbar slot 2 |
| Thumb 2 | F14 | F14 → hotbar slot 3 |
| Top button | F15 | F15 → hotbar slot 4 |
| DPI | F16 | F16 → hotbar slot 5 |

---

## Technical details

### `hotbarActions[i].hotkey`

Each hotbar entry gains an optional `hotkey` field (string). Persisted in `sf_settings` alongside the existing `actionId / name / label`. Empty string = no binding.

### Renderer-as-source-of-truth + atomic sync

On every hotbar mutation (add / remove / rename / hotkey edit) the renderer builds a `slotIdx → accel` map from `hotbarActions` and pushes it via the new `hotbarSyncHotkeys(map)` IPC. The main process atomically:

1. Unregisters every accelerator we previously bound (`_hotbarRegistered` Set tracks ownership so other features' globalShortcut bindings stay intact).
2. Resets `mouseHotbarBindings.Mouse4 / Mouse5` to null.
3. Walks the new map: `Mouse4` / `Mouse5` go into `mouseHotbarBindings` (handled by the existing PowerShell poller in `startCtrlPoller`); everything else goes through `globalShortcut.register(accel, () => mainWindow.webContents.send('overlay-fire-hotbar', idx))` — same IPC the pop-out uses for click-to-fire.

Returns `{ ok, registered, failed, conflicted }` so the renderer can surface failures (combo already taken by another app — `globalShortcut.register` returns `false` silently otherwise) and conflicts (combo collides with overlay-toggle or overlay-vis hotkeys — those keep priority and the slot binding gets skipped).

### Capture mode

`captureHotbarHotkey(idx)` attaches a one-shot keydown + mousedown listener to the slot's hotkey input. Modifiers compose as `Ctrl+Shift+Alt+<Key>`; arrow / space keys map to Electron's accelerator vocabulary; `MouseEvent.button === 3 / 4` (browser side-buttons) translate to `Mouse4` / `Mouse5`. Esc cancels and restores the previous value.

### Startup re-registration

After `loadSettings()` restores `hotbarActions`, the bootstrap IIFE calls `syncHotbarHotkeys()` once on a 0ms `setTimeout` — the deferral ensures `electronAPI.hotbarSyncHotkeys` is wired (preload runs at DOMContentLoaded, but the IPC handler is registered in `app.whenReady`).

### Notes

- Auth regression: 16/16 PASS.
- Backward-compatible: existing hotbar entries without a `hotkey` field stay unchanged. Existing `mouseHotbarBindings` get overwritten on first sync (same data, just routed through the new path).
- Same-accel duplicates across slots are rejected client-side with a sysMsg row — `globalShortcut.register` would silently fail on the duplicate anyway, but the up-front rejection makes the cause visible.
