// Rotation Relay client — main-process WebSocket subscriber.
//
// Connects to the Cloudflare Durable Object relay at
//   wss://aquilo-rotation-relay.bisherclay.workers.dev/relay/<roomKey>?role=sub
// (configurable). The roomKey is the same UUID the Rotation widget shows under
// "Connect to StreamFusion" in its config — the streamer pastes it into the SF
// settings panel once and forgets about it.
//
// Events received become BOTH:
//   - A renderer-side `rotation-event` IPC, which the events tab subscribes to
//     so song activity shows up alongside chat/alerts/discord events.
//   - An `obs-broadcast-chat` system row, so the OBS chat overlay picks up
//     "Now playing", "Song requested", etc. without any per-overlay wiring.
//
// State lives in `userData/rotation-relay.json`:
//   { enabled: bool, roomKey: string, relayBase: string }
//
// Reconnection: exponential backoff capped at 30s. Heartbeat / displaced
// detection comes from the server (kinds `_status`, `_ping`, close code 4001).

'use strict';

var WebSocket = require('ws');
var fs = require('fs');
var path = require('path');
var electron = require('electron');
var app = electron.app;

var DEFAULT_RELAY_BASE = 'wss://aquilo-rotation-relay.aquiloplays.workers.dev';
var STATE_FILE = 'rotation-relay.json';

var state = null;             // loaded config, see loadState()
var ws = null;
var reconnectTimer = null;
var backoffMs = 1000;
var stoppedByUser = false;
var lastStatus = { connected: false, reason: 'idle', subs: 0, lastEventAt: null };
var mainWindowRef = null;     // set by main.js so we can forward to renderer

// ─── State persistence ─────────────────────────────────────────────────────
function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function loadState() {
  if (state) return state;
  try {
    var raw = fs.readFileSync(statePath(), 'utf8');
    state = JSON.parse(raw) || {};
  } catch (e) {
    state = {};
  }
  if (typeof state.enabled  !== 'boolean') state.enabled  = false;
  if (typeof state.roomKey  !== 'string')  state.roomKey  = '';
  if (typeof state.relayBase !== 'string') state.relayBase = DEFAULT_RELAY_BASE;
  return state;
}

function saveState() {
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8'); }
  catch (e) { /* best effort — disk full / readonly volume */ }
}

// ─── Event translation ─────────────────────────────────────────────────────
// Translates a relay envelope into the shape SF's existing surfaces expect.
// We DON'T own how the renderer renders these — we just dump them into the
// same IPC channels the Discord/Twitch sources use.
function translateAndForward(envelope) {
  if (!envelope || !envelope.kind) return;

  // Internal control kinds — track them but don't render.
  if (envelope.kind === '_status') {
    lastStatus.subs = (envelope.data && envelope.data.subs) || 0;
    notifyStatus();
    return;
  }
  if (envelope.kind === '_ping' || envelope.kind === '_error') {
    if (envelope.kind === '_error') {
      console.warn('[rotation-relay] server error:', envelope.data && envelope.data.reason);
    }
    return;
  }

  lastStatus.lastEventAt = Date.now();

  // Send a structured event to the renderer for the events tab. Mirroring
  // discord-bot.js's `discord-event` IPC shape: { kind, data, ts }.
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    try {
      mainWindowRef.webContents.send('rotation-event', {
        kind: envelope.kind,
        data: envelope.data || {},
        ts:   envelope.ts || Date.now(),
      });
    } catch (e) { /* renderer gone */ }
  }

  // Also push to the OBS chat overlay so streams currently broadcasting see
  // song activity inline. The chat overlay accepts free-form rows; we shape
  // this as a system message with a Rotation badge so it reads as a non-chat
  // event when shown.
  var row = chatRowForEvent(envelope);
  if (row && mainWindowRef && !mainWindowRef.isDestroyed()) {
    try { mainWindowRef.webContents.send('rotation-relay-broadcast', row); }
    catch (e) {}
  }
}

function chatRowForEvent(envelope) {
  var d = envelope.data || {};
  var kind = envelope.kind;
  if (kind === 'rotation.song.playing') {
    var line = '♪ Now playing: ' + (d.title || 'Unknown') +
               (d.artist ? ' — ' + d.artist : '');
    if (d.requestedBy) line += '  · req @' + d.requestedBy;
    return {
      kind: 'system',
      source: 'rotation',
      text: line,
      ts: envelope.ts || Date.now(),
      meta: d,
    };
  }
  if (kind === 'rotation.song.queued') {
    return {
      kind: 'system',
      source: 'rotation',
      text: '♪ @' + (d.displayName || d.user || 'viewer') +
            ' queued: ' + (d.title || d.query || '?') +
            (d.artist ? ' — ' + d.artist : '') +
            (d.position ? ' (#' + d.position + ')' : ''),
      ts: envelope.ts || Date.now(),
      meta: d,
    };
  }
  if (kind === 'rotation.song.requested') {
    return {
      kind: 'system',
      source: 'rotation',
      text: '♪ @' + (d.displayName || d.user || 'viewer') +
            ' requested: ' + (d.query || '?'),
      ts: envelope.ts || Date.now(),
      meta: d,
    };
  }
  if (kind === 'rotation.song.rejected') {
    return {
      kind: 'system',
      source: 'rotation',
      text: '♪ @' + (d.displayName || d.user || 'viewer') +
            ' request denied (' + (d.reason || 'rejected') + ')',
      ts: envelope.ts || Date.now(),
      meta: d,
    };
  }
  if (kind === 'rotation.song.skipped') {
    return {
      kind: 'system',
      source: 'rotation',
      text: '♪ Skipped' + (d.title ? ': ' + d.title : ''),
      ts: envelope.ts || Date.now(),
      meta: d,
    };
  }
  return null;
}

// ─── Status broadcasting ───────────────────────────────────────────────────
function notifyStatus() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  try { mainWindowRef.webContents.send('rotation-relay-status', getStatus()); }
  catch (e) {}
}

function getStatus() {
  var s = loadState();
  return {
    enabled: !!s.enabled,
    connected: !!lastStatus.connected,
    reason: lastStatus.reason,
    subs: lastStatus.subs,
    lastEventAt: lastStatus.lastEventAt,
    roomKey: s.roomKey,
    relayBase: s.relayBase,
  };
}

// ─── Connection lifecycle ──────────────────────────────────────────────────
function buildUrl(s) {
  var base = (s.relayBase || DEFAULT_RELAY_BASE).replace(/\/$/, '');
  // Allow https:// / http:// in the config — coerce to ws/wss for the socket.
  base = base.replace(/^http/, 'ws');
  return base + '/relay/' + encodeURIComponent(s.roomKey) + '?role=sub';
}

function connect() {
  var s = loadState();
  if (!s.enabled || !s.roomKey) {
    lastStatus = { connected: false, reason: 'disabled', subs: 0, lastEventAt: lastStatus.lastEventAt };
    notifyStatus();
    return;
  }

  // Tear down any existing socket cleanly before opening a new one.
  if (ws) {
    try { ws.removeAllListeners(); ws.close(); } catch (e) {}
    ws = null;
  }

  lastStatus.connected = false;
  lastStatus.reason = 'connecting';
  notifyStatus();

  var url;
  try { url = buildUrl(s); }
  catch (e) {
    lastStatus.reason = 'invalid_url';
    notifyStatus();
    return;
  }

  try { ws = new WebSocket(url); }
  catch (e) {
    lastStatus.reason = 'open_failed';
    notifyStatus();
    scheduleReconnect();
    return;
  }

  ws.on('open', function() {
    backoffMs = 1000;
    lastStatus.connected = true;
    lastStatus.reason = 'open';
    notifyStatus();
  });

  ws.on('message', function(buf) {
    var text;
    try { text = buf.toString('utf8'); } catch (e) { return; }
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    translateAndForward(msg);
  });

  ws.on('close', function(code, reason) {
    lastStatus.connected = false;
    if (code === 4001) {
      // 4001 = displaced, but only the publisher can be displaced. Subscribers
      // shouldn't see this; treat as ordinary close + reconnect.
    }
    lastStatus.reason = 'closed:' + (code || 'unknown');
    notifyStatus();
    scheduleReconnect();
  });

  ws.on('error', function(/* err */) {
    // Close handler will fire after this — let it do the reconnect bookkeeping
    // so we don't double-schedule.
  });
}

function scheduleReconnect() {
  if (stoppedByUser) return;
  var s = loadState();
  if (!s.enabled || !s.roomKey) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

function disconnect() {
  stoppedByUser = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    try { ws.removeAllListeners(); ws.close(1000, 'client_stop'); } catch (e) {}
    ws = null;
  }
  lastStatus = { connected: false, reason: 'stopped', subs: 0, lastEventAt: lastStatus.lastEventAt };
  notifyStatus();
}

// ─── Public API ────────────────────────────────────────────────────────────
function setMainWindow(win) {
  mainWindowRef = win || null;
}

function start() {
  stoppedByUser = false;
  var s = loadState();
  if (s.enabled && s.roomKey) connect();
  else notifyStatus();
}

function stop() {
  disconnect();
}

function setConfig(patch) {
  var s = loadState();
  if (typeof patch.enabled   === 'boolean') s.enabled   = patch.enabled;
  if (typeof patch.roomKey   === 'string')  s.roomKey   = patch.roomKey.trim();
  if (typeof patch.relayBase === 'string')  s.relayBase = patch.relayBase.trim() || DEFAULT_RELAY_BASE;
  saveState();
  // Re-handshake with the new config.
  stoppedByUser = false;
  if (s.enabled && s.roomKey) connect();
  else disconnect();
  return getStatus();
}

function getConfig() {
  return loadState();
}

module.exports = {
  setMainWindow: setMainWindow,
  start:         start,
  stop:          stop,
  setConfig:     setConfig,
  getConfig:     getConfig,
  getStatus:     getStatus,
};
