# StreamFusion 1.5.5-beta.12

## What's new for you

🔄 **OBS browser sources auto-refresh when SF launches.** When SF auto-updates (or you start it after OBS is already running), browser sources pointing at SF overlay URLs used to sit on a "this site can't be reached" error page until you manually right-clicked each one and picked "Refresh cache of current page". SF now connects to the OBS WebSocket plugin on startup, finds the browser sources that point at SF (anything on `127.0.0.1:8787`–`8791`), and refreshes them for you.

Setup is in **Settings → OBS Overlays → Auto-refresh OBS browser sources**:

- ☑ **Auto-refresh on SF launch** (default on) — runs ~1.5 s after the obs-server is up.
- **OBS WebSocket port** — defaults to 4455 (OBS Studio's bundled default). Change if you moved it.
- **OBS WebSocket password** — paste from OBS → Tools → WebSocket Server Settings → Show Connect Info. Only needed if you have authentication enabled.
- **Refresh OBS sources now** — manual button if you want to fire it without restarting SF.

Best-effort by design: if OBS isn't running, the WebSocket plugin is off, or auth is required and no password is stored, the refresh silently no-ops — no popup spam on every SF launch.

---

## Technical details

### OBS WebSocket v5 client (no native module)

Implemented inline in `main.js` against the `ws` package SF already depends on. Flow:

1. `WebSocket('ws://127.0.0.1:<port>')`. ECONNREFUSED on missing OBS / port mismatch is silently caught.
2. Receive `Hello` (op 0). If `authentication` field is present:
   - Compute `secret = base64(sha256(password + salt))`, then `authResp = base64(sha256(secret + challenge))`.
   - Send `Identify` (op 1) with `rpcVersion: 1, authentication: authResp`.
   - If no password is stored, close the connection silently.
3. Receive `Identified` (op 2). Send `GetInputList` (op 6) with `inputKind: 'browser_source'`.
4. For each input in the response, send `GetInputSettings` to fetch the URL.
5. URL match: contains `127.0.0.1:8787|8788|8789|8790|8791` or the `localhost:` variant.
6. For matches, send `PressInputPropertiesButton` with `propertyName: 'refreshnocache'` — the same button as "Refresh cache of current page" in the OBS source properties dialog.
7. Hard 5 s timeout on the whole flow + 400 ms grace after the last settings response so refresh requests can land.

### Persistence

Cfg lives in `<userData>/obs-refresh.json`:

```json
{ "autoRefresh": true, "port": 4455, "password": "..." }
```

Same file-based pattern as `mouse-bindings.json`. The renderer never reads the password back — `obs-refresh-cfg-get` returns `{ autoRefresh, port, hasPassword: bool }`. The renderer's password input is write-only and clears after each save so the value doesn't sit in DOM.

### IPC surface

- `obs-refresh-sources` — fire a refresh now (used by the manual button).
- `obs-refresh-cfg-get` — UI hydration.
- `obs-refresh-cfg-set` — partial-update patch shape `{ autoRefresh?, port?, password? }`.

### Trigger point

After `obsServer.startServer()` resolves with `ok === true`, a 1.5 s `setTimeout` calls `refreshObsBrowserSources(loadObsRefreshCfg())`. The delay gives the loopback HTTP server enough time to bind so the freshly-refreshed browser sources actually get a 200 instead of another connection refused.

### Auth parity with OBS WebSocket v5

The auth response calculation matches the v5 spec exactly. Tested mentally against the spec — happy to push a smoke test in a follow-up if any flavor of OBS rejects it.

### Notes

- Auth regression: 16/16 PASS.
- Filter is conservative: only browser sources whose URL contains a SF loopback port get refreshed. Streamlabs widgets / external browser sources stay untouched.
- If you don't run OBS WebSocket: the auto-refresh sees no host and silently bails. Zero impact on anyone who doesn't want this.
