// Local HTTP + Server-Sent Events server that powers the browser-source
// overlays for OBS. Entirely local (binds to 127.0.0.1 only) — the streamer
// pastes a URL like http://127.0.0.1:8787/chat into an OBS Browser Source,
// and OBS renders the overlay from this Electron app's embedded server.
// Settings changes in StreamFusion push to OBS live via SSE, so there's no
// refresh / no files to manage / no credentials to expose.
//
// Why SSE instead of WebSocket: one-way server→client is all we need, and
// SSE ships in the Node `http` module with zero npm deps. The browser's
// EventSource API handles auto-reconnect on its own.
//
// The OBS overlays are free for everyone — the server serves them to any
// request with no entitlement check.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 8787;
const BIND_HOST = '127.0.0.1';
const HEARTBEAT_MS = 25000;     // keep SSE connections from idling out

let server = null;
let serverPort = DEFAULT_PORT;
let sseClients = new Set();     // { res, overlayType }
let heartbeatTimer = null;

// Last-known state per overlay — replayed to new clients so OBS browser
// sources render immediately on (re)connect without waiting for the next
// live event. Covers the "streamer reloads OBS scene" case gracefully.
let lastConfig   = { chat: {}, alerts: {}, shoutout: {}, vertical: {}, ticker: {}, viewers: {}, goals: {} };
// Last stats packet, replayed to a freshly-connected viewers overlay so OBS
// shows the current count on scene load without waiting for the next tick.
let lastStats    = null;

// Config persistence. As of 2026-06-09 the per-overlay cfg comes from the
// aquilo.gg/sf/customize/ page (POST /api/config/<overlay>), not SF's own
// settings UI. We write it to disk so a SF restart restores the look
// without the streamer reopening the customizer. Path is set by main.js
// via setConfigDir(); falls back to a sibling file next to this module
// if running outside Electron (CI smoke tests).
const VALID_OVERLAYS = ['chat', 'alerts', 'shoutout', 'vertical', 'ticker', 'viewers', 'goals'];
let configDir = __dirname;            // overridden by setConfigDir(app.getPath('userData'))
let configWriteTimer = null;          // debounce , dragging a slider must not hammer disk

function _configPath() { return path.join(configDir, 'obs-config.json'); }

function setConfigDir(dir) {
  if (typeof dir !== 'string' || !dir) return;
  configDir = dir;
}

function _loadConfigFromDisk() {
  try {
    var raw = fs.readFileSync(_configPath(), 'utf8');
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      VALID_OVERLAYS.forEach(function(k) {
        if (parsed[k] && typeof parsed[k] === 'object') lastConfig[k] = parsed[k];
      });
    }
  } catch (e) {
    // ENOENT on first boot is expected , no log
    if (e && e.code !== 'ENOENT') console.warn('[obs-server] config load failed:', e.message);
  }
}

function _persistConfigSoon() {
  if (configWriteTimer) clearTimeout(configWriteTimer);
  configWriteTimer = setTimeout(function() {
    configWriteTimer = null;
    // Atomic write: a crash mid-write must not truncate obs-config.json and
    // silently wipe the streamer's saved overlay look (the load path falls
    // back to defaults on a parse error). Write a temp file then rename over
    // the target; rename is atomic on the same volume.
    var target = _configPath();
    var tmp = target + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(lastConfig, null, 2), 'utf8');
      fs.renameSync(tmp, target);
    } catch (e) {
      console.warn('[obs-server] config save failed:', e.message);
      try { fs.unlinkSync(tmp); } catch (e2) {}
    }
  }, 250);
}

// ── Aquilo product integration registry ────────────────────────────────────
// Companion products (Aquilo Spotify widget, Aquilo Streamer.Bot kit, future
// products) POST to /api/integrations/register on startup. Their entry stays
// alive as long as they heartbeat at least every 60s; otherwise they're
// pruned. SF's renderer queries /api/integrations/list to surface what's
// connected in Settings → Integrations → Aquilo Products.
//
// Registry is in-memory only — every product is expected to re-register on
// SF restart or its own restart. Keeps stale entries from accumulating.
const INTEGRATIONS_STALE_MS = 60000;
let integrations = new Map();      // clientId -> {clientId, product, version, capabilities, port, urls, lastSeen, meta}
let integrationsSseClients = new Set();
let integrationsCounter = 0;
// Per-client control streams. Companion products (e.g. Aquilo Spotify Widget)
// hold one SSE connection here so SF can push directives back at them — skip,
// play/pause, previous, etc. Map of clientId -> { res } so pushControl can
// write to a specific product without blasting all of them.
let controlStreams = new Map();

function _newClientId() {
  integrationsCounter += 1;
  return 'sf-int-' + Date.now().toString(36) + '-' + integrationsCounter;
}

function _broadcastIntegrationsEvent(eventName, payload) {
  const line = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  integrationsSseClients.forEach(function(c) {
    try { c.res.write(line); } catch (e) { integrationsSseClients.delete(c); }
  });
}

function _closeControlStream(clientId, reason) {
  const c = controlStreams.get(clientId);
  if (!c) return;
  try { c.res.write('event: shutdown\ndata: ' + JSON.stringify({ reason: reason || 'closed' }) + '\n\n'); } catch (e) {}
  try { c.res.end(); } catch (e) {}
  controlStreams.delete(clientId);
}

function _pruneStaleIntegrations() {
  const cutoff = Date.now() - INTEGRATIONS_STALE_MS;
  let pruned = false;
  integrations.forEach(function(v, k) {
    if (v.lastSeen < cutoff) {
      integrations.delete(k);
      _closeControlStream(k, 'stale');
      pruned = true;
      _broadcastIntegrationsEvent('unregistered', { clientId: k, reason: 'stale' });
    }
  });
  return pruned;
}

function listIntegrations() {
  _pruneStaleIntegrations();
  return Array.from(integrations.values());
}

// Push a control directive to a specific client's SSE control stream. The
// client must have opened /api/integrations/control-stream?clientId=X.
// Returns true if the directive was queued, false if the client has no
// open stream (caller can decide whether to surface a "widget offline"
// hint to the user). `command` is a free-form string like 'play' / 'pause'
// / 'skip' / 'previous'; `args` is an optional object the widget interprets.
function pushControl(clientId, command, args) {
  const c = controlStreams.get(clientId);
  if (!c) return false;
  const payload = { command: String(command || ''), args: (args && typeof args === 'object') ? args : {} };
  try {
    c.res.write('event: control\ndata: ' + JSON.stringify(payload) + '\n\n');
    return true;
  } catch (e) {
    controlStreams.delete(clientId);
    return false;
  }
}

// As of 2026-06-09 the five OBS overlay HTML files are hosted canonically
// at https://aquilo.gg/sf/overlay/<name>/ , see Aquilo/aquilo-site/public/
// sf/overlay/. The local routes below now 302-redirect there. Editing
// the overlays no longer requires a new StreamFusion release; an
// aquilo-site deploy ships the change to every active streamer the next
// time their OBS browser source reloads. The hosted page reaches back
// into THIS server's /events stream via SSE (sf-bridge.js does the
// port discovery), and CORS:* on /events lets the cross-origin call
// through.
//
// Local fs.readFileSync of obs-overlays/*.html is gone. The folder
// itself was emptied in the same change; a MIGRATED.md remains for
// anyone landing in that dir from a stale clone.
var HOSTED_OVERLAY_BASE = 'https://aquilo.gg/sf/overlay/';
var OVERLAY_ROUTE_MAP = {
  '/chat':     'chat',
  '/alerts':   'alerts',
  '/shoutout': 'shoutout',
  '/vertical': 'vertical',
  '/ticker':   'ticker',
  '/viewers':  'viewers',
  '/goals':    'goals'
};

// Very small landing page for when the streamer hits
// http://127.0.0.1:8787/ in a browser to check the server is alive.
// Recommends the aquilo.gg URLs (canonical) but also shows the legacy
// 127.0.0.1 paths, both as a "yes the server is up" sanity check and
// because existing OBS browser sources still use the local form. OBS
// itself never loads this , it's purely for humans poking at the URL.
function landingPage() {
  var urls = getUrls();
  var rows = [
    { name: 'Chat feed',          hosted: HOSTED_OVERLAY_BASE + 'chat/',     legacy: urls.chat },
    { name: 'Alerts banner',      hosted: HOSTED_OVERLAY_BASE + 'alerts/',   legacy: urls.alerts },
    { name: 'Shoutout card',      hosted: HOSTED_OVERLAY_BASE + 'shoutout/', legacy: urls.shoutout },
    { name: 'Vertical bar',       hosted: HOSTED_OVERLAY_BASE + 'vertical/', legacy: urls.vertical },
    { name: 'Horizontal ticker',  hosted: HOSTED_OVERLAY_BASE + 'ticker/',   legacy: urls.ticker }
  ];
  var listHtml = rows.map(function(r) {
    return '<li><div class="lbl">' + r.name + '</div>' +
           '<code>' + r.hosted + '</code>' +
           '<div class="legacy">Legacy (still works via redirect): <code class="muted">' + r.legacy + '</code></div></li>';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>StreamFusion — OBS Overlays</title>' +
         '<style>body{font-family:Geist,"Geist Sans",-apple-system,Segoe UI,sans-serif;background:#0a0b12;color:#ffffff;padding:32px;max-width:680px;margin:0 auto}' +
         'h1{font-size:20px;font-weight:800;letter-spacing:-0.01em;margin:0 0 4px} .sub{color:#94a3b8;margin:0 0 22px;font-size:13px;line-height:1.55}' +
         '.sub a{color:#9a82ff;text-decoration:none} .sub a:hover{text-decoration:underline}' +
         'ul{list-style:none;padding:0;margin:0} li{background:#11131c;border:1px solid #1f2233;border-radius:10px;padding:14px 16px;margin-bottom:10px}' +
         '.lbl{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}' +
         'code{font-family:SFMono-Regular,Consolas,monospace;font-size:12px;color:#9a82ff;user-select:all}' +
         'code.muted{color:#64748b}' +
         '.legacy{font-size:10px;color:#64748b;margin-top:6px}' +
         'p.hint{font-size:11px;color:#94a3b8;margin-top:18px;line-height:1.6}</style></head>' +
         '<body><h1>StreamFusion , OBS Browser Source Overlays</h1>' +
         '<p class="sub">The overlay HTML is hosted at <a href="' + HOSTED_OVERLAY_BASE + '" target="_blank">aquilo.gg/sf/overlay</a> ' +
         'so design changes ship without a new StreamFusion release. Paste the aquilo.gg URL into OBS → Sources → + → Browser Source. ' +
         'StreamFusion (this app) still drives the chat + events; the hosted page just renders them.</p>' +
         '<ul>' + listHtml + '</ul>' +
         '<p class="hint">Both forms need StreamFusion running. Set the browser source width/height in OBS as needed , overlays are transparent-backed.</p></body></html>';
}

function serveHtml(res, body, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

// ── Anti-drive-by / DNS-rebind protection ──────────────────────────────────
// The server is loopback-only, but a webpage the streamer visits can still
// reach 127.0.0.1 from their browser. Two guards:
//   1. Host header must be loopback. A DNS-rebind attacker points their own
//      hostname at 127.0.0.1, so the Host header gives them away.
//   2. State-changing POSTs and the chat SSE only honor known-good Origins
//      (the hosted overlays + customizer on aquilo.gg, plus localhost). The
//      browser sets Origin and page JS cannot forge it, so a random site's
//      drive-by POST is rejected and it cannot read the live-chat stream.
// aquilo.gg and ALL its subdomains (widget.aquilo.gg hosts the Spotify/
// rotation widget, which registers + heartbeats against this server), plus
// loopback for local testing.
var ALLOWED_ORIGIN_RE = /^https?:\/\/(([a-z0-9-]+\.)*aquilo\.gg|localhost|127\.0\.0\.1)(:\d+)?$/i;
var HOSTED_OVERLAY_ORIGIN = 'https://aquilo.gg';
function _originAllowed(origin) { return !origin || ALLOWED_ORIGIN_RE.test(origin); }
function _acao(req) {
  var o = req.headers['origin'];
  // Reflect an allowed origin; otherwise return aquilo.gg so a disallowed
  // cross-origin reader can't match it and is blocked from reading the body.
  return (o && ALLOWED_ORIGIN_RE.test(o)) ? o : HOSTED_OVERLAY_ORIGIN;
}
function _hostOk(req) {
  var host = String(req.headers['host'] || '').replace(/:\d+$/, '').toLowerCase();
  return host === '' || host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function handleRequest(req, res) {
  var u = new URL(req.url, 'http://127.0.0.1:' + serverPort);
  var p = u.pathname;

  // Reject non-loopback Host headers (DNS-rebinding defense).
  if (!_hostOk(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  // Health / ping endpoint — used by the settings panel to verify the
  // server is up without actually opening the overlay.
  if (p === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, entitled: true, port: serverPort }));
    return;
  }

  // SSE stream. Accepts ?type=chat|alerts|shoutout so each overlay only
  // receives messages relevant to it — the broadcaster uses that filter
  // to skip serializing for clients who don't care.
  if (p === '/events') {
    var overlayType = u.searchParams.get('type') || 'all';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // Restrict who can READ the live chat stream cross-origin. A random
      // site the streamer visits gets aquilo.gg here, which won't match its
      // own origin, so the browser blocks it from reading viewers' chat.
      'Access-Control-Allow-Origin': _acao(req)
    });
    // Initial "hello" with the last-known config for this overlay type,
    // so a fresh OBS connection renders with the right settings without
    // waiting for the streamer to touch the settings panel. `entitled`
    // is always true — overlays are free for everyone — and is kept in
    // the payload only so existing overlay clients parse it cleanly.
    var cfg = lastConfig[overlayType] || {};
    var hello = { entitled: true, cfg: cfg };
    // The viewers overlay wants the current count on scene load, not just
    // the next tick — replay the last stats packet in its hello.
    if (overlayType === 'viewers' && lastStats) hello.stats = lastStats;
    res.write('event: hello\ndata: ' + JSON.stringify(hello) + '\n\n');

    var client = { res: res, overlayType: overlayType };
    sseClients.add(client);
    req.on('close', function() { sseClients.delete(client); });
    return;
  }

  // Overlays serve to everyone , no entitlement check. The HTML lives on
  // aquilo.gg now; we 302-redirect so existing OBS browser sources
  // pointing at http://127.0.0.1:8787/chat keep working without the
  // streamer having to re-paste a new URL into OBS. The aquilo.gg page
  // then opens an EventSource straight back to this server's /events
  // stream (sf-bridge.js discovers the active port).
  if (OVERLAY_ROUTE_MAP[p]) {
    res.writeHead(302, {
      'Location':                    HOSTED_OVERLAY_BASE + OVERLAY_ROUTE_MAP[p] + '/',
      'Cache-Control':               'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end();
    return;
  }

  if (p === '/' || p === '/index.html') {
    serveHtml(res, landingPage());
    return;
  }

  // ── /api/config/<overlay> ────────────────────────────────────────────────
  // The canonical surface that aquilo.gg/sf/customize/ uses to drive the
  // overlays. GET returns the current persisted cfg (so the page can
  // hydrate its inputs on open); POST replaces it wholesale and broadcasts
  // to every connected overlay of that type. Loopback-only by virtue of
  // BIND_HOST='127.0.0.1', so no auth needed beyond that.
  var configMatch = /^\/api\/config\/([a-z]+)\/?$/.exec(p);
  if (configMatch) {
    var which = configMatch[1];
    if (VALID_OVERLAYS.indexOf(which) === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'unknown overlay; expected one of ' + VALID_OVERLAYS.join(', ') }));
      return;
    }
    if (req.method === 'OPTIONS') {
      // Answer the preflight inline rather than 405-ing , every POST from
      // a cross-origin page (e.g. aquilo.gg/sf/customize/) sends one of
      // these because of the Content-Type: application/json header.
      res.writeHead(204, {
        'Access-Control-Allow-Origin':  _acao(req),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Cache-Control':               'no-store',
        'Access-Control-Allow-Origin': _acao(req)
      });
      res.end(JSON.stringify({ overlay: which, cfg: lastConfig[which] || {} }));
      return;
    }
    if (req.method === 'POST') {
      // State-changing: reject drive-by POSTs from pages whose origin isn't
      // the hosted customizer/overlays (or localhost). The browser sets
      // Origin and page JS can't forge it.
      if (!_originAllowed(req.headers['origin'])) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': _acao(req) });
        res.end(JSON.stringify({ error: 'origin not allowed' }));
        return;
      }
      var cfgChunks = [];
      var cfgTotal = 0;
      req.on('data', function(d) {
        cfgChunks.push(d);
        cfgTotal += d.length;
        if (cfgTotal > 32768) { req.destroy(); }   // generous; cfg objects are <2KB
      });
      req.on('end', function() {
        var body = null;
        try { body = JSON.parse(Buffer.concat(cfgChunks).toString('utf-8') || '{}'); } catch (e) {}
        if (!body || typeof body !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'cfg must be a JSON object' }));
          return;
        }
        // setConfig persists to disk + broadcasts to live overlays via SSE
        setConfig(which, body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, overlay: which }));
      });
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'method not allowed; use GET or POST' }));
    return;
  }

  // GET /api/config , bulk hydrate. Returns the cfg for every overlay so
  // the customizer page can populate all five tabs in one round-trip
  // instead of pinging /api/config/<overlay> five times.
  if (p === '/api/config' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Cache-Control':               'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ cfg: lastConfig }));
    return;
  }

  // ── /api/integrations/* ──────────────────────────────────────────────────
  // Aquilo companion-product handshake. Lightweight HTTP — no auth besides
  // the loopback bind, since localhost-only. Spotify widget + SB kit + any
  // future Aquilo product connect here so the streamer sees them in SF.

  if (p === '/api/integrations/list' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ products: listIntegrations() }));
    return;
  }

  if (p === '/api/integrations/events' && req.method === 'GET') {
    // SSE channel for live registered/unregistered updates. SF UI listens
    // here so the Aquilo Products panel stays current without polling.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('event: hello\ndata: ' + JSON.stringify({ products: listIntegrations() }) + '\n\n');
    var ic = { res: res };
    integrationsSseClients.add(ic);
    req.on('close', function() { integrationsSseClients.delete(ic); });
    return;
  }

  if (p === '/api/integrations/control-stream' && req.method === 'GET') {
    // Per-client SSE channel for SF -> companion product directives (skip,
    // play/pause, etc.). The widget opens this on register; SF writes via
    // pushControl(clientId, command, args). One stream per clientId — a new
    // connection from the same client displaces the old one (handles widget
    // page reload without piling up zombie streams).
    var csClientId = u.searchParams.get('clientId') || '';
    if (!csClientId || !integrations.has(csClientId)) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'unknown clientId — register first' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    // Displace any existing stream for this clientId.
    var existing = controlStreams.get(csClientId);
    if (existing) {
      try { existing.res.write('event: shutdown\ndata: {"reason":"displaced"}\n\n'); } catch (e) {}
      try { existing.res.end(); } catch (e) {}
    }
    res.write('event: hello\ndata: ' + JSON.stringify({ clientId: csClientId }) + '\n\n');
    var cs = { res: res, clientId: csClientId };
    controlStreams.set(csClientId, cs);
    req.on('close', function() {
      // Only delete if it's still us — a displacing connection would have
      // already replaced this entry.
      var current = controlStreams.get(csClientId);
      if (current === cs) controlStreams.delete(csClientId);
    });
    return;
  }

  if (p === '/api/integrations/control' && req.method === 'POST') {
    // Cross-origin POST control endpoint. Mostly used by SF's own renderer
    // (via the obs-integration-control IPC) but exposed over HTTP too so
    // companion tooling on the same machine can drive a widget without
    // shipping its own SB integration. Origin-gated so a random web page
    // can't skip/pause the streamer's connected widgets.
    if (!_originAllowed(req.headers['origin'])) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': _acao(req) });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
      return;
    }
    var ctlChunks = [];
    req.on('data', function(d) {
      ctlChunks.push(d);
      if (ctlChunks.reduce(function(n, b) { return n + b.length; }, 0) > 4096) { req.destroy(); }
    });
    req.on('end', function() {
      var body = {};
      try { body = JSON.parse(Buffer.concat(ctlChunks).toString('utf-8') || '{}'); } catch (e) {}
      if (!body.clientId || !body.command) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'clientId + command required' }));
        return;
      }
      var sent = pushControl(String(body.clientId), String(body.command).slice(0, 32), body.args);
      res.writeHead(sent ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: sent, reason: sent ? null : 'no open control stream for that clientId' }));
    });
    return;
  }

  if ((p === '/api/integrations/register' || p === '/api/integrations/heartbeat' || p === '/api/integrations/unregister') && req.method === 'POST') {
    if (!_originAllowed(req.headers['origin'])) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': _acao(req) });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
      return;
    }
    var chunks = [];
    req.on('data', function(d) {
      chunks.push(d);
      if (chunks.reduce(function(n, b) { return n + b.length; }, 0) > 16384) { req.destroy(); }
    });
    req.on('end', function() {
      var body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch (e) {}

      if (p === '/api/integrations/register') {
        if (!body.product || typeof body.product !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'product field required' }));
          return;
        }
        var clientId = body.clientId && integrations.has(body.clientId) ? body.clientId : _newClientId();
        var entry = {
          clientId:     clientId,
          product:      String(body.product).slice(0, 64),
          version:      String(body.version || '').slice(0, 32),
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.slice(0, 32).map(function(c) { return String(c).slice(0, 64); }) : [],
          port:         (typeof body.port === 'number' && body.port > 0) ? body.port : null,
          urls:         (body.urls && typeof body.urls === 'object') ? body.urls : {},
          meta:         (body.meta && typeof body.meta === 'object') ? body.meta : {},
          lastSeen:     Date.now()
        };
        integrations.set(clientId, entry);
        _broadcastIntegrationsEvent('registered', { product: entry });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, clientId: clientId, heartbeatMs: 30000 }));
        return;
      }

      if (p === '/api/integrations/heartbeat') {
        var hbId = body.clientId;
        if (!hbId || !integrations.has(hbId)) {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'unknown clientId — re-register' }));
          return;
        }
        var rec = integrations.get(hbId);
        rec.lastSeen = Date.now();
        if (body.meta && typeof body.meta === 'object') Object.assign(rec.meta, body.meta);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (p === '/api/integrations/unregister') {
        if (body.clientId && integrations.has(body.clientId)) {
          integrations.delete(body.clientId);
          _closeControlStream(body.clientId, 'unregistered');
          _broadcastIntegrationsEvent('unregistered', { clientId: body.clientId });
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    });
    return;
  }

  // CORS preflight for /api/integrations/* AND /api/config/* , companion
  // products and the aquilo.gg/sf/customize/ page hit these from a
  // different origin so the browser sends a preflight for any POST with
  // Content-Type: application/json.
  if ((p.indexOf('/api/integrations') === 0 || p.indexOf('/api/config') === 0) && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end('Not found');
}

// Try the requested port first, then fall back to the next 4 ports if
// EADDRINUSE. This protects against the common "auto-update restarted SF
// while OBS still held the SSE socket open" case — the new process would
// otherwise fail to bind to 8787 and ALL overlays would silently die.
// On a successful bind the actual port is stored in `serverPort`, so
// getUrls() always returns the URL OBS should be using.
function _attemptListen(port) {
  return new Promise(function(resolve) {
    var srv = http.createServer(handleRequest);
    var settled = false;
    srv.once('error', function(err) {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch (e) {}
      resolve({ ok: false, code: err && err.code, msg: err && err.message });
    });
    srv.listen(port, BIND_HOST, function() {
      if (settled) return;
      settled = true;
      resolve({ ok: true, srv: srv, port: port });
    });
  });
}

function startServer(port) {
  if (server) return Promise.resolve(true);
  // Load persisted overlay cfg before binding , so the first SSE 'hello'
  // a freshly-connecting OBS browser source receives carries the streamer's
  // last-saved look, not the empty default.
  _loadConfigFromDisk();
  var requested = (typeof port === 'number' && port > 0) ? port : DEFAULT_PORT;
  // First requested port + four fallbacks. Picked in a small fixed range
  // so the streamer's OBS browser-source URL is at most a few ports off
  // the documented one (and getUrls() / Settings UI reflect the actual
  // live port either way).
  var candidates = [requested, requested + 1, requested + 2, requested + 3, requested + 4];
  return (async function tryNext(i) {
    if (i >= candidates.length) {
      console.error('[obs-server] all candidate ports busy: ' + candidates.join(', '));
      return false;
    }
    var p = candidates[i];
    var attempt = await _attemptListen(p);
    if (attempt.ok) {
      server = attempt.srv;
      serverPort = attempt.port;
      // Re-attach the listener handlers main.js relies on.
      server.on('error', function(err) {
        console.error('[obs-server] runtime error:', err && err.message);
      });
      console.log('[obs-server] listening on http://' + BIND_HOST + ':' + serverPort + (p !== requested ? ' (fallback from ' + requested + ')' : ''));
      // Periodic heartbeat keeps proxies / NAT / OBS from silently dropping
      // idle SSE connections (a long quiet stream would eventually look
      // dead to some intermediate layer). Same timer also prunes Aquilo
      // companion products that stopped heartbeating.
      heartbeatTimer = setInterval(function() {
        sseClients.forEach(function(c) {
          try { c.res.write(': hb\n\n'); } catch (e) { sseClients.delete(c); }
        });
        integrationsSseClients.forEach(function(c) {
          try { c.res.write(': hb\n\n'); } catch (e) { integrationsSseClients.delete(c); }
        });
        controlStreams.forEach(function(c, k) {
          try { c.res.write(': hb\n\n'); } catch (e) { controlStreams.delete(k); }
        });
        _pruneStaleIntegrations();
      }, HEARTBEAT_MS);
      return true;
    }
    // Retry on either common failure mode:
    //   EADDRINUSE — another process is bound (most common: SF's previous
    //                instance still holding the socket through TIME_WAIT
    //                after auto-update restart).
    //   EACCES     — port is in a Windows excluded-port range (Hyper-V /
    //                Docker Desktop / WSL2 carve these out on install or
    //                Windows-update reboot, and a port that worked
    //                yesterday silently fails today).
    if (attempt.code === 'EADDRINUSE' || attempt.code === 'EACCES') {
      console.warn('[obs-server] port ' + p + ' unavailable (' + attempt.code + '), trying ' + candidates[i + 1]);
      return tryNext(i + 1);
    }
    console.error('[obs-server] listen error on ' + p + ': ' + attempt.msg + ' (code ' + attempt.code + ')');
    return false;
  })(0);
}

function stopServer() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  sseClients.forEach(function(c) {
    try { c.res.write('event: shutdown\ndata: {}\n\n'); } catch (e) {}
    try { c.res.end(); } catch (e) {}
  });
  sseClients.clear();
  controlStreams.forEach(function(c) {
    try { c.res.write('event: shutdown\ndata: {"reason":"server_stop"}\n\n'); } catch (e) {}
    try { c.res.end(); } catch (e) {}
  });
  controlStreams.clear();
  if (server) {
    try { server.close(); } catch (e) {}
    server = null;
  }
}

// Broadcast a message to all overlay clients, optionally filtered by type.
// `type` is 'chat' | 'alert' | 'shoutout' | 'config' — the overlay HTMLs
// listen for the matching `event:` SSE event name.
//
// targetOverlay can be:
//   - a single string ('chat', 'alerts', 'shoutout', 'vertical')
//   - an array of strings (e.g. ['chat', 'vertical']) to fan out to more
//     than one overlay type (chat messages go to both the chat overlay
//     AND the vertical bar, for instance)
//   - omitted / null — broadcast to every connected client
function broadcast(type, data, targetOverlay) {
  var payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
  var targets = targetOverlay
    ? (Array.isArray(targetOverlay) ? targetOverlay : [targetOverlay])
    : null;
  sseClients.forEach(function(c) {
    // overlayType === 'all' (landing page case) sees everything; otherwise
    // only forward events that match one of the client's allowed overlay
    // types OR are config pushes (which everyone wants).
    if (targets && c.overlayType !== 'all' && targets.indexOf(c.overlayType) === -1) return;
    try { c.res.write(payload); } catch (e) { sseClients.delete(c); }
  });
}

// Persist the latest per-overlay config so replay works on reconnect.
// Also broadcasts immediately to connected overlays of that type, and
// schedules a debounced disk write so a SF restart restores the look
// without the streamer reopening the customizer page.
function setConfig(overlayType, cfg) {
  if (!overlayType || !cfg) return;
  lastConfig[overlayType] = cfg;
  broadcast('config', cfg, overlayType);
  _persistConfigSoon();
}

// Live viewer counts for the viewers overlay. Stores the last packet for
// replay-on-connect, then fans out to connected viewers overlays.
//   stats = { viewers:{tw,yt,tt,kk}, total, show:{tw,yt,tt,kk} }
function broadcastStats(stats) {
  if (!stats) return;
  lastStats = stats;
  broadcast('stats', stats, ['viewers', 'goals']);
}

// Retained as a no-op so main.js's existing call site stays valid.
// OBS overlays are free for everyone — there is no entitlement gate to
// toggle. (Kept rather than removed to preserve the module's exports.)
function setEntitled(/* v */) {}

function getUrls() {
  var base = 'http://' + BIND_HOST + ':' + serverPort;
  return {
    root:        base + '/',
    chat:        base + '/chat',
    alerts:      base + '/alerts',
    shoutout:    base + '/shoutout',
    vertical:    base + '/vertical',
    ticker:      base + '/ticker',
    viewers:     base + '/viewers',
    // The renderer compares port vs defaultPort to decide whether to
    // show a "port shifted — update your OBS sources" banner. Set after
    // a successful bind so the value is always live.
    port:        serverPort,
    defaultPort: DEFAULT_PORT
  };
}

function isRunning() { return server !== null; }
function connectedClients() { return sseClients.size; }

module.exports = {
  startServer:      startServer,
  stopServer:       stopServer,
  broadcast:        broadcast,
  broadcastStats:   broadcastStats,
  setConfig:        setConfig,
  setConfigDir:     setConfigDir,  // main.js calls this before startServer
  setEntitled:      setEntitled,
  getUrls:          getUrls,
  isRunning:        isRunning,
  connectedClients: connectedClients,
  // Aquilo product registry
  listIntegrations: listIntegrations,
  pushControl:      pushControl
};
