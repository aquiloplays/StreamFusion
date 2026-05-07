# StreamFusion 1.5.5-beta.13

## What's new for you

✅ **Auto-refresh OBS sources is visibly on by default.** The behaviour was already on under the hood since beta.12 (no config file = `autoRefresh: true`), but the settings checkbox started visually unchecked and only flipped to checked once the hydration roundtrip finished — which made it look like an off-by-default opt-in. Now the HTML checkbox has the `checked` attribute baked in so the visual state matches the actual default from the moment the panel renders.

If you previously turned it off explicitly, that preference still wins — the hydration unchecks the box once it reads your saved cfg.

---

## Technical details

One-line diff: `<input type="checkbox" id="obsAutoRefresh" onchange="...">` → `<input type="checkbox" id="obsAutoRefresh" checked onchange="...">`. The runtime cfg flow is unchanged — `loadObsRefreshCfg()` still returns `{ autoRefresh: true }` for missing configs, and `_hydrateObsRefreshCfg()` still calls `auto.checked = c.autoRefresh !== false` on hydration. Only the initial paint is affected.

### Notes

- Auth regression: 16/16 PASS.
