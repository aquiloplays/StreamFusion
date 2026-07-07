# StreamFusion 1.21.6: hand your mods the OBS controls

Warden's OBS bridge grows up. Beyond the BRB-panic button, you can now let your
mod team trigger a curated set of OBS actions from the Warden console — including
sliding your camera out of the way when it's covering game UI. Everything is
opt-in and per-target: nothing is exposed until you allowlist it in the Warden
Bridge pane, and mods only ever see exactly what you chose.

## 🎛️ New mod OBS capabilities

- **Move a camera / source / group** — mods snap an allowlisted source to a
  corner or the center of the current scene (with a one-tap Reset), so they can
  keep your facecam off the minimap without touching your layout.
- **Clip that** — save the replay buffer so a mod catches the moment.
- **Adjust volume** — quick dB presets on the inputs you allow.
- **Media control** — play / pause / restart / stop a media source.
- **Refresh a browser source** — un-freeze a stuck alert or overlay.
- **Toggle a filter** — flip a specific pre-made filter (blur cam, a "be right
  back" mask) that you pick.
- **Fire a hotkey** — trigger any OBS hotkey you've bound and allowlisted
  (markers, plugin actions, whatever).

## 🔒 You stay in control

- Every capability is **off by default** and scoped to the exact scenes, sources,
  mics, filters, and hotkeys you choose in **Settings → Printer → Warden Bridge**.
- Scan OBS to populate the pickers, tick what mods may touch, done.
- Mod commands are re-checked against your allowlist on the server and again on
  this machine before OBS is ever touched, and every action is logged in Warden's
  audit feed.
