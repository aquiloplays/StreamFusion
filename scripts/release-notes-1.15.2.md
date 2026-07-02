# StreamFusion 1.15.2: instant launch feedback

One fix, and it is an old annoyance finally run to ground.

## 🔧 Fixed

- **"I click StreamFusion and nothing happens, so I click it again"**: on a
  cold start the window stayed invisible until the interface finished
  loading, which could take several seconds (longer right after an update).
  The window now appears **instantly** as a dark shell and fills in as it
  loads, so one click is one launch. If StreamFusion is already running in
  the tray, clicking the shortcut still just brings it to the front.
