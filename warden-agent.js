// ── Warden machine agent ─────────────────────────────────────────────────
// StreamFusion acts as Warden's on-machine agent for things that only exist
// locally: it relays non-Twitch chat into Warden's unified feed, and it
// executes broadcaster-allowlisted OBS commands that mods trigger from the
// Warden console. Both flow through the WardenRoom Durable Object; SF joins
// it with a key-authed 'agent' ticket (the same machine key it uses for the
// receipt gallery). The capability allowlist is authored in SF's Printer/
// Warden pane and mirrored to the worker so the router can validate mod
// commands server-side — the agent only ever runs what the room hands it,
// but the server-side allowlist is the real gate.

const https = require('https');
const path = require('path');
const fs = require('fs');

const WORKER = 'loadout-discord.aquiloplays.workers.dev';

// Command spec — MUST match discord-bot/warden-obs.js on the worker.
const MEDIA_ACTIONS = ['play', 'pause', 'restart', 'stop', 'next', 'previous'];
const MOVE_TARGETS = ['topleft', 'topright', 'bottomleft', 'bottomright', 'center', 'reset'];
// TriggerMediaInputAction enum values, keyed by our short verb.
const MEDIA_ENUM = {
  play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  next: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT',
  previous: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS',
};
// Margin from the canvas edge when snapping a source to a corner (px).
const MOVE_MARGIN = 16;
// Remembered pre-move transforms so `reset` can restore a source's original
// spot. Keyed by "scene::source"; in-memory (cleared on SF restart), which is
// fine — reset is a convenience, not a guarantee.
const _moveOriginals = new Map();

function _parseDb(s) {
  if (!/^-?\d{1,3}(\.\d+)?$/.test(String(s))) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n > 0 || n < -100) return null;
  return n;
}

let cfg = { enabled: false, streamerId: '', key: '', obs: { port: 4455, password: '' }, caps: null };
let ws = null;
let stopped = true;
let backoff = 2000;
let reconnectTimer = null;
let logFn = function () {};
let WSLib = null;

function init(opts) {
  if (opts && opts.log) logFn = opts.log;
  try { WSLib = require('ws'); } catch (e) { WSLib = null; }
}

// The renderer/main pushes config: whether the agent runs, the streamer id,
// the shared key, OBS connection, and the OBS capability allowlist.
function setConfig(patch) {
  if (!patch || typeof patch !== 'object') return getStatus();
  if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
  if (typeof patch.streamerId === 'string') cfg.streamerId = patch.streamerId;
  if (typeof patch.key === 'string') cfg.key = patch.key;
  if (patch.obs && typeof patch.obs === 'object') cfg.obs = patch.obs;
  if (patch.caps !== undefined) cfg.caps = patch.caps;
  // Relay the caps allowlist to the worker so the router can validate.
  if (patch.caps !== undefined && cfg.key && cfg.streamerId) pushCaps();
  if (cfg.enabled && cfg.key && cfg.streamerId) start();
  else stop();
  return getStatus();
}

function getStatus() {
  return {
    enabled: cfg.enabled,
    connected: !!(ws && ws.readyState === 1),
    streamerId: cfg.streamerId,
    hasCaps: !!(cfg.caps && cfg.caps.enabled),
  };
}

function _post(pathname, body, cb) {
  try {
    const data = JSON.stringify(body);
    const req = https.request({
      host: WORKER, path: pathname, method: 'POST', timeout: 8000,
      headers: { 'content-type': 'application/json', 'x-aquilo-print-key': cfg.key, 'content-length': Buffer.byteLength(data) },
    }, function (res) {
      let out = '';
      res.on('data', function (c) { out += c; });
      res.on('end', function () { let j = null; try { j = JSON.parse(out); } catch (e) {} cb && cb(j, res.statusCode); });
    });
    req.on('error', function () { cb && cb(null, 0); });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb && cb(null, 0); });
    req.end(data);
  } catch (e) { cb && cb(null, 0); }
}

function pushCaps() {
  _post('/api/warden-obscaps', { streamerId: cfg.streamerId, caps: cfg.caps || { enabled: false } }, function () {});
}

// ── Chat relay ───────────────────────────────────────────────────────────
// Called from main (via IPC from the renderer) for each normalized
// non-Twitch chat line. Fire-and-forget, best-effort.
function relayChat(msg) {
  if (!cfg.enabled || !cfg.key || !cfg.streamerId || !msg) return;
  const platform = String(msg.platform || '').toLowerCase();
  if (platform !== 'kick' && platform !== 'youtube' && platform !== 'tiktok') return;
  if (!msg.user || !msg.text) return;
  _post('/api/warden-ingest', {
    streamerId: cfg.streamerId, platform,
    user: String(msg.user).slice(0, 60), text: String(msg.text).slice(0, 500),
    color: msg.color || '',
  }, function () {});
}

// ── Room connection (agent role) ──────────────────────────────────────────
function start() {
  if (!stopped) return;
  stopped = false;
  connect();
}

function stop() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { if (ws) ws.close(); } catch (e) {}
  ws = null;
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (!stopped) connect();
  }, backoff);
  backoff = Math.min(backoff * 1.6, 30000);
}

function connect() {
  if (stopped || !WSLib || !cfg.key || !cfg.streamerId) return;
  _post('/api/warden-agent-ticket', { streamerId: cfg.streamerId }, function (j) {
    if (stopped) return;
    if (!j || !j.ok || !j.wsUrl) { scheduleReconnect(); return; }
    try { ws = new WSLib(j.wsUrl); }
    catch (e) { scheduleReconnect(); return; }

    ws.on('open', function () { backoff = 2000; logFn('warden agent connected'); });
    ws.on('message', function (raw) {
      let frame = null;
      try { frame = JSON.parse(raw.toString()); } catch (e) { return; }
      if (frame && frame.t === 'obs-cmd') handleObsCmd(frame);
    });
    ws.on('close', function () { ws = null; scheduleReconnect(); });
    ws.on('error', function () { try { if (ws) ws.close(); } catch (e) {} });
  });
}

function replyResult(cmdId, action, ok, error) {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'obs-result', cmdId, action, ok: !!ok, error: error || undefined }));
    }
  } catch (e) {}
}

// ── OBS command execution (OBS WebSocket v5) ──────────────────────────────
function handleObsCmd(frame) {
  const action = String(frame.action || '');
  const arg = String(frame.arg || '');
  const arg2 = String(frame.arg2 || '');
  const caps = cfg.caps || {};
  // Local re-check mirrors the server allowlist (defense in depth). Kept in
  // lockstep with discord-bot/warden-obs.js isObsCommandAllowed.
  const inList = function (l, v) { return Array.isArray(l) && l.indexOf(v) !== -1; };
  const allowed =
    (action === 'brbPanic' && caps.brbPanic) ||
    (action === 'sceneSwitch' && inList(caps.scenes, arg)) ||
    (action === 'sourceToggle' && inList(caps.sources, arg)) ||
    (action === 'muteMic' && inList(caps.mics, arg)) ||
    (action === 'saveReplay' && caps.replay === true) ||
    (action === 'filterToggle' && !!arg && !!arg2 && inList(caps.filters, arg + '::' + arg2)) ||
    (action === 'setVolume' && inList(caps.volumes, arg) && _parseDb(arg2) !== null) ||
    (action === 'mediaControl' && inList(caps.media, arg) && MEDIA_ACTIONS.indexOf(arg2) !== -1) ||
    (action === 'refreshBrowser' && inList(caps.browsers, arg)) ||
    (action === 'fireHotkey' && inList(caps.hotkeys, arg)) ||
    (action === 'moveSource' && inList(caps.movable, arg) && MOVE_TARGETS.indexOf(arg2) !== -1);
  if (!allowed) { replyResult(frame.cmdId, action, false, 'not-allowed'); return; }

  obsRun(function (obs, done) {
    if (action === 'sceneSwitch') {
      obs.req('SetCurrentProgramScene', { sceneName: arg }, function (ok) { done(ok); });
    } else if (action === 'muteMic') {
      obs.req('ToggleInputMute', { inputName: arg }, function (ok) { done(ok); });
    } else if (action === 'brbPanic') {
      const scene = caps.brbScene || arg;
      obs.req('SetCurrentProgramScene', { sceneName: scene }, function (ok) {
        // Mute every configured mic on the way out; report success on the
        // scene switch even if a mic name is stale.
        const mics = caps.mics || [];
        let i = 0;
        (function next() {
          if (i >= mics.length) { done(ok); return; }
          obs.req('SetInputMute', { inputName: mics[i], inputMuted: true }, function () { i++; next(); });
        })();
      });
    } else if (action === 'sourceToggle') {
      _withSceneItem(obs, arg, function (sceneName, id) {
        if (id == null) { done(false); return; }
        obs.req('GetSceneItemEnabled', { sceneName, sceneItemId: id }, function (ok3, d3) {
          if (!ok3) { done(false); return; }
          obs.req('SetSceneItemEnabled', { sceneName, sceneItemId: id, sceneItemEnabled: !(d3 && d3.sceneItemEnabled) }, function (ok4) { done(ok4); });
        });
      });
    } else if (action === 'saveReplay') {
      // Requires the replay buffer to be running; OBS errors otherwise and we
      // surface that so the mod knows to ask the streamer to start it.
      obs.req('SaveReplayBuffer', {}, function (ok) { done(ok); });
    } else if (action === 'filterToggle') {
      obs.req('GetSourceFilter', { sourceName: arg, filterName: arg2 }, function (ok, d) {
        if (!ok) { done(false); return; }
        obs.req('SetSourceFilterEnabled', {
          sourceName: arg, filterName: arg2, filterEnabled: !(d && d.filterEnabled),
        }, function (ok2) { done(ok2); });
      });
    } else if (action === 'setVolume') {
      const db = _parseDb(arg2);
      if (db === null) { done(false); return; }
      obs.req('SetInputVolume', { inputName: arg, inputVolumeDb: db }, function (ok) { done(ok); });
    } else if (action === 'mediaControl') {
      const mediaAction = MEDIA_ENUM[arg2];
      if (!mediaAction) { done(false); return; }
      obs.req('TriggerMediaInputAction', { inputName: arg, mediaAction }, function (ok) { done(ok); });
    } else if (action === 'refreshBrowser') {
      // The documented way to hard-refresh a browser source's cache.
      obs.req('PressInputPropertiesButton', { inputName: arg, propertyName: 'refreshnocache' }, function (ok) { done(ok); });
    } else if (action === 'fireHotkey') {
      obs.req('TriggerHotkeyByName', { hotkeyName: arg }, function (ok) { done(ok); });
    } else if (action === 'moveSource') {
      _moveSource(obs, arg, arg2, done);
    } else {
      done(false);
    }
  }, function (ok, err) {
    replyResult(frame.cmdId, action, ok, err);
  });
}

// Resolve a source/group name to its scene-item id in the CURRENT program
// scene, then hand (sceneName, sceneItemId) to cb. cb gets (sceneName, null)
// when the source isn't in the current scene.
function _withSceneItem(obs, sourceName, cb) {
  obs.req('GetCurrentProgramScene', {}, function (ok, d) {
    const sceneName = d && (d.currentProgramSceneName || d.sceneName);
    if (!ok || !sceneName) { cb(null, null); return; }
    obs.req('GetSceneItemId', { sceneName, sourceName }, function (ok2, d2) {
      if (!ok2 || !d2 || d2.sceneItemId == null) { cb(sceneName, null); return; }
      cb(sceneName, d2.sceneItemId);
    });
  });
}

// Snap a source/group to a preset spot in the current program scene, or
// `reset` it to where it sat before the first move this session. Forces
// top-left position alignment so the corner math is deterministic.
function _moveSource(obs, sourceName, target, done) {
  _withSceneItem(obs, sourceName, function (sceneName, id) {
    if (id == null) { done(false); return; }
    const key = sceneName + '::' + sourceName;
    obs.req('GetSceneItemTransform', { sceneName, sceneItemId: id }, function (okT, dT) {
      if (!okT || !dT || !dT.sceneItemTransform) { done(false); return; }
      const tf = dT.sceneItemTransform;
      if (target === 'reset') {
        const orig = _moveOriginals.get(key);
        if (!orig) { done(true); return; } // never moved → nothing to undo
        obs.req('SetSceneItemTransform', {
          sceneName, sceneItemId: id,
          sceneItemTransform: { positionX: orig.positionX, positionY: orig.positionY, alignment: orig.alignment },
        }, function (ok) { done(ok); });
        return;
      }
      // Remember the original spot once, so reset is honest even after several
      // moves.
      if (!_moveOriginals.has(key)) {
        _moveOriginals.set(key, {
          positionX: tf.positionX, positionY: tf.positionY,
          alignment: (typeof tf.alignment === 'number' ? tf.alignment : 5),
        });
      }
      obs.req('GetVideoSettings', {}, function (okV, dV) {
        if (!okV || !dV) { done(false); return; }
        const baseW = dV.baseWidth, baseH = dV.baseHeight;
        const w = tf.width || 0, h = tf.height || 0; // rendered (post-scale) size
        const M = MOVE_MARGIN;
        let x = M, y = M;
        if (target === 'topleft') { x = M; y = M; }
        else if (target === 'topright') { x = baseW - w - M; y = M; }
        else if (target === 'bottomleft') { x = M; y = baseH - h - M; }
        else if (target === 'bottomright') { x = baseW - w - M; y = baseH - h - M; }
        else if (target === 'center') { x = (baseW - w) / 2; y = (baseH - h) / 2; }
        else { done(false); return; }
        // alignment 5 = top-left (OBS_ALIGN_LEFT|OBS_ALIGN_TOP), so positionX/Y
        // is the item's top-left corner — matching the math above.
        obs.req('SetSceneItemTransform', {
          sceneName, sceneItemId: id,
          sceneItemTransform: { positionX: Math.round(x), positionY: Math.round(y), alignment: 5 },
        }, function (ok) { done(ok); });
      });
    });
  });
}

// Connect to OBS, authenticate, hand a small request runner to `body`, then
// close. `body(obs, done)` calls done(ok) when finished; `after(ok, err)`
// fires once with the outcome.
function obsRun(body, after) {
  if (!WSLib) { after(false, 'no-ws'); return; }
  const port = (cfg.obs && cfg.obs.port) || 4455;
  const password = (cfg.obs && cfg.obs.password) || '';
  let sock;
  try { sock = new WSLib('ws://127.0.0.1:' + port); }
  catch (e) { after(false, 'no-obs'); return; }
  let settled = false;
  const finish = function (ok, err) {
    if (settled) return; settled = true;
    try { sock.close(); } catch (e) {}
    after(ok, err);
  };
  const timer = setTimeout(function () { finish(false, 'timeout'); }, 6000);
  const pending = new Map();
  let seq = 0;
  const obs = {
    req: function (requestType, requestData, cb) {
      const id = 'r' + (seq++);
      pending.set(id, cb);
      try { sock.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData: requestData || {} } })); }
      catch (e) { pending.delete(id); cb(false); }
    },
  };
  sock.on('error', function (e) { clearTimeout(timer); finish(false, (e && e.code === 'ECONNREFUSED') ? 'no-obs' : 'error'); });
  sock.on('close', function () { clearTimeout(timer); });
  sock.on('message', function (raw) {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.op === 0) {
      const auth = msg.d && msg.d.authentication;
      if (auth) {
        if (!password) { finish(false, 'auth-required'); return; }
        const crypto = require('crypto');
        const secret = crypto.createHash('sha256').update(password + auth.salt).digest('base64');
        const resp = crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
        try { sock.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: resp } })); } catch (e) {}
      } else {
        try { sock.send(JSON.stringify({ op: 1, d: { rpcVersion: 1 } })); } catch (e) {}
      }
    } else if (msg.op === 2) {
      // Identified — run the caller's body.
      body(obs, function (ok) { clearTimeout(timer); finish(ok !== false, ok === false ? 'obs-failed' : undefined); });
    } else if (msg.op === 7) {
      const d = msg.d;
      const cb = pending.get(d.requestId);
      if (!cb) return;
      pending.delete(d.requestId);
      const ok = d.requestStatus && d.requestStatus.result === true;
      cb(ok, d.responseData || {});
    }
  });
}

// List OBS scenes / inputs / groups / hotkeys / per-source filters so the
// streamer can build every allowlist in the pane. Returns via cb({ scenes,
// sources, mics, media, browsers, hotkeys, groups, filters }). filters is a
// flat list of { source, filter } pairs. Best-effort: any sub-probe that
// fails just leaves its list empty.
function probeObs(cb) {
  const out = { scenes: [], sources: [], mics: [], media: [], browsers: [], hotkeys: [], groups: [], filters: [] };
  obsRun(function (obs, done) {
    obs.req('GetSceneList', {}, function (ok, d) {
      if (ok && d && Array.isArray(d.scenes)) out.scenes = d.scenes.map(function (s) { return s.sceneName; });
      obs.req('GetInputList', {}, function (ok2, d2) {
        const inputs = (ok2 && d2 && d2.inputs) || [];
        out.sources = inputs.map(function (i) { return i.inputName; });
        const kindOf = function (i) { return String(i.inputKind || i.unversionedInputKind || ''); };
        out.mics = inputs.filter(function (i) { return /audio|wasapi|coreaudio|pulse|mic/i.test(kindOf(i)); }).map(function (i) { return i.inputName; });
        out.media = inputs.filter(function (i) { return /ffmpeg_source|vlc_source|media/i.test(kindOf(i)); }).map(function (i) { return i.inputName; });
        out.browsers = inputs.filter(function (i) { return /browser_source/i.test(kindOf(i)); }).map(function (i) { return i.inputName; });
        // Hotkeys (for TriggerHotkeyByName) and groups (movable targets).
        obs.req('GetHotkeyList', {}, function (okH, dH) {
          if (okH && dH && Array.isArray(dH.hotkeys)) out.hotkeys = dH.hotkeys;
          obs.req('GetGroupList', {}, function (okG, dG) {
            if (okG && dG && Array.isArray(dG.groups)) out.groups = dG.groups;
            // Per-source + per-scene filters → "source::filter" candidates.
            // Bounded so a huge collection can't stall the scan.
            const targets = out.scenes.concat(out.sources).slice(0, 80);
            let i = 0;
            (function nextFilter() {
              if (i >= targets.length) { done(true); return; }
              const name = targets[i++];
              obs.req('GetSourceFilterList', { sourceName: name }, function (okF, dF) {
                const fl = (okF && dF && Array.isArray(dF.filters)) ? dF.filters : [];
                fl.forEach(function (f) { out.filters.push({ source: name, filter: f.filterName }); });
                nextFilter();
              });
            })();
          });
        });
      });
    });
  }, function () { cb(out); });
}

module.exports = { init, setConfig, getStatus, relayChat, probeObs, stop };
