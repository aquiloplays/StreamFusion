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
// Entitlement gate: the HTTP routes that serve overlays check the module
// `isEntitled` flag, which main.js toggles from Patreon entitlement events.
// If a non-Tier-2/3 user somehow has the URL loaded, they see a "requires
// Early Access" page instead of the overlay. The server itself keeps
// listening so URLs stay valid across sign-in / sign-out transitions.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 8787;
const BIND_HOST = '127.0.0.1';
const HEARTBEAT_MS = 25000;     // keep SSE connections from idling out

let server = null;
let serverPort = DEFAULT_PORT;
let isEntitled = false;         // flipped by setEntitled() from main.js
let sseClients = new Set();     // { res, overlayType }
let heartbeatTimer = null;

// Last-known state per overlay — replayed to new clients so OBS browser
// sources render immediately on (re)connect without waiting for the next
// live event. Covers the "streamer reloads OBS scene" case gracefully.
let lastConfig   = { chat: {}, alerts: {}, shoutout: {}, vertical: {} };

// Read an overlay file from disk each request. File reads are cheap and
// reading fresh means dev-mode hot-editing of the HTML works without an
// app restart (electron-builder bundles the files into the asar for prod;
// fs can still read out of asar via Node's patched fs).
function readOverlayFile(name) {
  try {
    return fs.readFileSync(path.join(__dirname, 'obs-overlays', name), 'utf8');
  } catch (e) {
    return '<!doctype html><html><body style="font-family:sans-serif;color:#f87171;background:#0e0e10;padding:24px">' +
           '<h2>StreamFusion overlay missing</h2><p>File not found: ' + name + '</p></body></html>';
  }
}

// Tiny gated page shown when a request arrives but EA isn't active. OBS
// will render this transparent-ish; the text is mostly a signal to the
// streamer when they preview the URL in a real browser.
function gatedPage() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>StreamFusion — Early Access</title>' +
         '<style>html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,Segoe UI,sans-serif;color:#efeff1}' +
         '.wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box}' +
         '.card{background:rgba(14,14,16,.85);border:1px solid rgba(255,66,77,.5);border-radius:12px;padding:20px 24px;max-width:420px;text-align:center;backdrop-filter:blur(8px)}' +
         '.t{font-size:14px;font-weight:800;color:#ff424d;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px}' +
         '.m{font-size:13px;line-height:1.5;color:#adadb8}</style></head>' +
         '<body><div class="wrap"><div class="card"><div class="t">Early Access only</div>' +
         '<div class="m">This OBS overlay requires an active StreamFusion Patreon supporter sign-in at Tier&nbsp;2 or Tier&nbsp;3.<br><br>Open StreamFusion → Settings → <strong>Early Access</strong> to connect your Patreon.</div>' +
         '</div></div></body></html>';
}

// Very small landing page listing the three overlay URLs, for when the
// streamer hits http://127.0.0.1:8787/ in a browser to check the server
// is alive. OBS never loads this — it's purely for humans.
function landingPage() {
  var urls = getUrls();
  return '<!doctype html><html><head><meta charset="utf-8"><title>StreamFusion — OBS Overlays</title>' +
         '<style>body{font-family:-apple-system,Segoe UI,sans-serif;background:#0e0e10;color:#efeff1;padding:32px;max-width:640px;margin:0 auto}' +
         'h1{font-size:20px;font-weight:800;letter-spacing:-0.01em;margin:0 0 4px} .sub{color:#adadb8;margin:0 0 24px;font-size:13px}' +
         'ul{list-style:none;padding:0;margin:0} li{background:#18181b;border:1px solid #2a2a30;border-radius:10px;padding:14px 16px;margin-bottom:10px}' +
         '.lbl{font-size:11px;font-weight:700;color:#8a8a98;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}' +
         'code{font-family:SFMono-Regular,Consolas,monospace;font-size:12px;color:#3A86FF;user-select:all}' +
         'p.hint{font-size:11px;color:#8a8a98;margin-top:18px;line-height:1.6}</style></head>' +
         '<body><h1>StreamFusion — OBS Browser Source Overlays</h1><p class="sub">Paste these URLs into OBS → Sources → + → Browser Source.</p><ul>' +
         '<li><div class="lbl">Chat feed</div><code>' + urls.chat + '</code></li>' +
         '<li><div class="lbl">Alerts banner</div><code>' + urls.alerts + '</code></li>' +
         '<li><div class="lbl">Shoutout card</div><code>' + urls.shoutout + '</code></li>' +
         '<li><div class="lbl">Vertical bar</div><code>' + urls.vertical + '</code></li>' +
         '</ul><p class="hint">These URLs work only while StreamFusion is running. Set the browser source width/height in OBS as needed — overlays are transparent-backed.</p></body></html>';
}

function serveHtml(res, body, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function handleRequest(req, res) {
  var u = new URL(req.url, 'http://127.0.0.1:' + serverPort);
  var p = u.pathname;

  // Health / ping endpoint — used by the settings panel to verify the
  // server is up without actually opening the overlay. Always 200s
  // regardless of entitlement.
  if (p === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, entitled: isEntitled, port: serverPort }));
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
      'Access-Control-Allow-Origin': '*'
    });
    // Initial "hello" with the last-known config for this overlay type,
    // so a fresh OBS connection renders with the right settings without
    // waiting for the streamer to touch the settings panel.
    var cfg = lastConfig[overlayType] || {};
    res.write('event: hello\ndata: ' + JSON.stringify({ entitled: isEntitled, cfg: cfg }) + '\n\n');

    var client = { res: res, overlayType: overlayType };
    sseClients.add(client);
    req.on('close', function() { sseClients.delete(client); });
    return;
  }

  // Gating: overlays return a branded "requires EA" page if not entitled.
  // Keeps the streamer from wondering why their OBS is blank.
  if (p === '/chat' || p === '/alerts' || p === '/shoutout' || p === '/vertical') {
    if (!isEntitled) { serveHtml(res, gatedPage()); return; }
    var file = (p === '/chat')      ? 'chat.html'
             : (p === '/alerts')    ? 'alerts.html'
             : (p === '/shoutout')  ? 'shoutout.html'
             : 'vertical.html';
    serveHtml(res, readOverlayFile(file));
    return;
  }

  if (p === '/' || p === '/index.html') {
    if (!isEntitled) { serveHtml(res, gatedPage()); return; }
    serveHtml(res, landingPage());
    return;
  }

  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end('Not found');
}

function startServer(port) {
  if (server) return true;
  serverPort = typeof port === 'number' && port > 0 ? port : DEFAULT_PORT;
  return new Promise(function(resolve) {
    server = http.createServer(handleRequest);
    server.on('error', function(err) {
      console.error('[obs-server] listen error:', err && err.message);
      server = null;
      resolve(false);
    });
    server.listen(serverPort, BIND_HOST, function() {
      console.log('[obs-server] listening on http://' + BIND_HOST + ':' + serverPort);
      // Periodic heartbeat keeps proxies / NAT / OBS from silently dropping
      // idle SSE connections (a long quiet stream would eventually look
      // dead to some intermediate layer).
      heartbeatTimer = setInterval(function() {
        sseClients.forEach(function(c) {
          try { c.res.write(': hb\n\n'); } catch (e) { sseClients.delete(c); }
        });
      }, HEARTBEAT_MS);
      resolve(true);
    });
  });
}

function stopServer() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  sseClients.forEach(function(c) {
    try { c.res.write('event: shutdown\ndata: {}\n\n'); } catch (e) {}
    try { c.res.end(); } catch (e) {}
  });
  sseClients.clear();
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
  if (!isEntitled) return;
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
// Also broadcasts immediately to connected overlays of that type.
function setConfig(overlayType, cfg) {
  if (!overlayType || !cfg) return;
  lastConfig[overlayType] = cfg;
  broadcast('config', cfg, overlayType);
}

function setEntitled(v) {
  var was = isEntitled;
  isEntitled = !!v;
  // Tell existing overlay clients the gate flipped so they can show/hide
  // themselves without needing an OBS-side refresh.
  if (was !== isEntitled) {
    sseClients.forEach(function(c) {
      try { c.res.write('event: entitlement\ndata: ' + JSON.stringify({ entitled: isEntitled }) + '\n\n'); }
      catch (e) { sseClients.delete(c); }
    });
  }
}

function getUrls() {
  var base = 'http://' + BIND_HOST + ':' + serverPort;
  return {
    root:     base + '/',
    chat:     base + '/chat',
    alerts:   base + '/alerts',
    shoutout: base + '/shoutout',
    vertical: base + '/vertical'
  };
}

function isRunning() { return server !== null; }
function connectedClients() { return sseClients.size; }

module.exports = {
  startServer:      startServer,
  stopServer:       stopServer,
  broadcast:        broadcast,
  setConfig:        setConfig,
  setEntitled:      setEntitled,
  getUrls:          getUrls,
  isRunning:        isRunning,
  connectedClients: connectedClients
};
