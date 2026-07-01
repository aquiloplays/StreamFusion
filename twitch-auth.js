// Twitch account connection for StreamFusion (desktop).
//
// The app gets Twitch chat + events + mod actions + stream info through
// Streamer.bot, so this is NOT a chat/auth dependency. It's a direct line
// to the Twitch Helix API using the BROADCASTER'S OWN Twitch app, for the
// handful of things Streamer.bot doesn't already give the app , today that's
// the Clip button (POST /helix/clips), with a generic helix() helper so
// future direct-Helix features (raids, etc.) can reuse the same connection.
//
// Mirrors discord-auth.js so main.js wires it up the same way:
//   1. Start Twitch OAuth in the system browser; catch the callback on a
//      local loopback server (CSRF-protected state).
//   2. Exchange the code through the shared Cloudflare Worker
//      (POST /twitch-token) so client_secret never ships in the binary.
//      NOTE: Twitch's token endpoint lives on auth.aquilo.gg (the worker
//      redeployed to the aquilo account), NOT the old bisherclay
//      workers.dev URL that Patreon/Discord still default to.
//   3. Persist tokens (safeStorage-encrypted), refreshing on demand.
//   4. Emit `twitch-status-changed` to the renderer on connect/disconnect.
//
// Public status shape (getStatus / IPC payload):
//   { signedIn: bool, login: string, displayName: string, userId: string }
'use strict';

const { shell, safeStorage, ipcMain, app } = require('electron');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
// PUBLIC client_id is safe to ship; client_secret lives on the Worker.
const TWITCH_CLIENT_ID = process.env.SF_TWITCH_CLIENT_ID || '24i7na6gc2j9glbeee8450eydmd3qw';

// Twitch broker / token-exchange worker. Twitch endpoints are on
// auth.aquilo.gg (see patreon-proxy.worker.js → Twitch section); do NOT use
// the old streamfusion-patreon-proxy.bisherclay.workers.dev default that
// Patreon/Discord use, that deployment has no /twitch-token route.
const TOKEN_PROXY_URL = process.env.SF_TWITCH_TOKEN_PROXY_URL || 'https://auth.aquilo.gg/';

const TWITCH_OAUTH = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';

// Register ALL of these as OAuth Redirect URLs on dev.twitch.tv/console for
// the app (Twitch needs the literal hostname `localhost`, not 127.0.0.1):
//   http://localhost:17829/callback
//   http://localhost:17830/callback
//   http://localhost:17831/callback
const LOOPBACK_PORTS = [17829, 17830, 17831];

// clips:edit lets the broadcaster create clips on their own channel.
// channel:manage:raids lets the Raid Finder start/cancel raids directly via
// Helix (POST /helix/raids) instead of routing through Streamer.bot. The read
// scopes power the optional EventSub event source (subs/bits/follows/redeems
// direct from Twitch). Adding scopes here means the user re-authorizes
// (Connect Twitch again) to grant them.
const SCOPES = [
  'clips:edit',
  'channel:manage:raids',         // start/cancel raids (Raid Finder, native)
  'channel:read:subscriptions',   // subs, resubs, gifts
  'bits:read',                    // cheers
  'moderator:read:followers',     // follows
  'channel:read:redemptions',     // channel-point redeems + power-up auto-rewards
  'channel:read:hype_train',      // accurate hype trains (begin/progress/end)
  'channel:read:ads',             // ad-break heads-up + ad schedule countdown
  // ── Accuracy pass: native polls / predictions / charity ──
  'channel:read:polls',           // accurate live poll results
  'channel:read:predictions',     // accurate live prediction pools
  'channel:read:charity',         // charity campaign progress tracker
  // ── Alert overlays: shoutouts + suspicious-user mod safety ──
  'moderator:read:shoutouts',     // shoutout received/given events
  'moderator:read:suspicious_users', // flag likely ban-evaders in chat
  // ── Control surface (write scopes): SF drives Twitch directly ──
  'channel:manage:broadcast',     // edit title/category + create stream markers
  'channel:manage:ads',           // snooze the next scheduled ad
  'channel:edit:commercial',      // start an ad break on demand
  'channel:manage:polls',         // launch / end polls from SF
  'channel:manage:predictions',   // launch / lock / resolve predictions from SF
  'channel:manage:redemptions',   // approve / refund channel-point redemptions
  'moderator:manage:banned_users',   // native timeout / ban / unban
  'moderator:manage:chat_messages',  // native delete message
  'moderator:manage:announcements',  // native /announce (schedule go-live message)
  'user:write:chat',                 // send chat as the broadcaster (bot fallback)
  'channel:bot',                     // let the connected bot account post here
  'user:read:chat',                  // read own chat natively (SB-less chat + bot)
];

// A separate, minimal scope set for the OPTIONAL bot account (a second Twitch
// login the streamer connects so automated messages post under the bot's name
// instead of their own). It only ever needs to send chat.
// Kept identical to the auth.aquilo.gg vault's BOT_CONNECT_SCOPES so a bot
// account connected through either flow carries the same grant.
const BOT_SCOPES = [
  'user:read:chat',    // read chat as the bot (cloud bot parity)
  'user:write:chat',   // send chat messages
  'user:bot',          // be recognized as a bot (rate limits + allowed to post)
];

const STATE_SCHEMA_V = 1;

// ── State ────────────────────────────────────────────────────────────────────
let authResolver = null;
let loopbackServer = null;
let expectedState = null;
let mainWindowRef = null;

// role: 'broadcaster' (default) or 'bot'. The bot account persists to its own
// file so it never collides with the broadcaster's tokens.
function statePath(role) { return path.join(app.getPath('userData'), role === 'bot' ? 'twitch-bot-auth.json' : 'twitch-auth.json'); }

function writeState(obj, role) {
  try {
    obj.schema_v = STATE_SCHEMA_V;
    const json = JSON.stringify(obj);
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(statePath(role), JSON.stringify({ v: 1, enc: enc }), 'utf8');
    } else {
      fs.writeFileSync(statePath(role), JSON.stringify({ v: 1, raw: obj }), 'utf8');
    }
  } catch (e) { console.error('[twitch-auth] writeState failed:', e); }
}
function readState(role) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(role), 'utf8'));
    if (parsed.enc && safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.enc, 'base64')));
    }
    if (parsed.raw) return parsed.raw;
    return null;
  } catch (e) { return null; }
}
function clearState(role) { try { fs.unlinkSync(statePath(role)); } catch (e) {} }

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function postJson(url, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname + (u.search || ''), port: u.port || 443,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'StreamFusion' }
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const json = text ? JSON.parse(text) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode, body: json }));
        } catch (e) { reject(Object.assign(new Error('Non-JSON response'), { status: res.statusCode, body: text })); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('Token exchange timed out')); });
    req.write(data); req.end();
  });
}

// One Helix call with the broadcaster's bearer token + the app Client-Id.
function helixRequest(method, fullPath, accessToken, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(fullPath);
    const data = body != null ? JSON.stringify(body) : null;
    const headers = { 'Authorization': 'Bearer ' + accessToken, 'Client-Id': TWITCH_CLIENT_ID, 'User-Agent': 'StreamFusion' };
    if (data != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ method: method, hostname: u.hostname, path: u.pathname + (u.search || ''), port: 443, headers: headers }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {}; try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('Helix request timed out')); });
    if (data != null) req.write(data);
    req.end();
  });
}

function exchange(params) {
  const u = new URL(TOKEN_PROXY_URL);
  u.pathname = (u.pathname.replace(/\/+$/, '') + '/twitch-token').replace(/^\/+/, '/');
  return postJson(u.toString(), params);
}

// Return a valid access token, refreshing if expired. Throws if not signed in.
async function getValidToken(role) {
  const state = readState(role);
  if (!state || !state.access_token) throw new Error('not signed in');
  if (state.expires_at && Date.now() >= (state.expires_at - 60000) && state.refresh_token) {
    try {
      const t = await exchange({ grant_type: 'refresh_token', refresh_token: state.refresh_token });
      if (t && t.access_token) {
        state.access_token = t.access_token;
        if (t.refresh_token) state.refresh_token = t.refresh_token;
        state.expires_at = t.expires_in ? (Date.now() + t.expires_in * 1000) : null;
        writeState(state, role);
      }
    } catch (e) { /* fall through; a 401 below will surface the real failure */ }
  }
  return state;
}

// Generic Helix call (auto-refresh + one retry on 401). path is relative,
// e.g. 'clips', query is a querystring without '?'.
async function helix(method, path, query, body, role) {
  let state = await getValidToken(role);
  const url = HELIX + '/' + String(path).replace(/^\/+/, '') + (query ? ('?' + query) : '');
  let res = await helixRequest(method, url, state.access_token, body);
  if (res.status === 401 && state.refresh_token) {
    const t = await exchange({ grant_type: 'refresh_token', refresh_token: state.refresh_token }).catch(function () { return null; });
    if (t && t.access_token) {
      state.access_token = t.access_token;
      if (t.refresh_token) state.refresh_token = t.refresh_token;
      state.expires_at = t.expires_in ? (Date.now() + t.expires_in * 1000) : null;
      writeState(state, role);
      res = await helixRequest(method, url, state.access_token, body);
    }
  }
  return res;
}

// ── Loopback server for the OAuth redirect ───────────────────────────────────
function startLoopbackServer() {
  return new Promise(function (resolve, reject) {
    const attempts = LOOPBACK_PORTS.slice();
    (function tryNext() {
      if (!attempts.length) { reject(new Error('No loopback port available (tried ' + LOOPBACK_PORTS.join(', ') + ')')); return; }
      const port = attempts.shift();
      const srv = http.createServer(function (req, res) {
        if (!req.url) { res.writeHead(400); res.end('Bad request'); return; }
        const u = new URL(req.url, 'http://localhost:' + port);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end('Not found'); return; }
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        const errParam = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;background:#0e0e10;color:#e6e6f0;padding:40px"><h2>' +
          (errParam ? 'Twitch sign-in cancelled' : "You're connected!") +
          '</h2><p>You can close this tab and return to StreamFusion.</p>' +
          (errParam ? '' : '<script>setTimeout(function(){window.close()},1200)</script>') + '</body></html>');
        if (authResolver) {
          if (errParam) authResolver.reject(new Error('OAuth error: ' + errParam));
          else if (!state || state !== expectedState) authResolver.reject(new Error('OAuth state mismatch (possible CSRF)'));
          else if (!code) authResolver.reject(new Error('OAuth callback missing code'));
          else authResolver.resolve({ code: code, redirectUri: 'http://localhost:' + port + '/callback' });
          authResolver = null;
        }
      });
      srv.on('error', function (err) { if (err && err.code === 'EADDRINUSE') { tryNext(); return; } reject(err); });
      srv.listen(port, '127.0.0.1', function () { loopbackServer = srv; resolve(port); });
    })();
  });
}
function stopLoopbackServer() { if (loopbackServer) { try { loopbackServer.close(); } catch (e) {} loopbackServer = null; } }

// ── Status + events ──────────────────────────────────────────────────────────
function setMainWindow(win) { mainWindowRef = win; }
function publicStatus(state) {
  if (!state || !state.access_token) return { signedIn: false, login: '', displayName: '', userId: '' };
  return { signedIn: true, login: state.login || '', displayName: state.display_name || '', userId: state.user_id || '' };
}
function emitStatus(status, role) {
  var channel = role === 'bot' ? 'twitch-bot-status-changed' : 'twitch-status-changed';
  try { if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.webContents.send(channel, status); }
  catch (e) { /* non-fatal */ }
}

// ── Public flow ──────────────────────────────────────────────────────────────
// role: 'broadcaster' (default, full control scopes) or 'bot' (chat-send only).
async function beginAuth(role) {
  stopLoopbackServer();
  const port = await startLoopbackServer();
  const redirectUri = 'http://localhost:' + port + '/callback';
  expectedState = crypto.randomBytes(16).toString('hex');
  // force_verify makes Twitch always show the account picker, so the streamer
  // can pick a DIFFERENT account for the bot instead of silently reusing the
  // one they're already logged into in the browser.
  const scopeList = role === 'bot' ? BOT_SCOPES : SCOPES;
  const authUrl = TWITCH_OAUTH + '/authorize' +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(TWITCH_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&scope=' + encodeURIComponent(scopeList.join(' ')) +
    (role === 'bot' ? '&force_verify=true' : '') +
    '&state=' + expectedState;
  const codePromise = new Promise(function (resolve, reject) {
    authResolver = { resolve: resolve, reject: reject };
    setTimeout(function () { if (authResolver) { authResolver.reject(new Error('Sign-in timed out after 5 minutes')); authResolver = null; } }, 5 * 60 * 1000);
  });
  shell.openExternal(authUrl);
  try {
    const cb = await codePromise;
    const tokens = await exchange({ grant_type: 'authorization_code', code: cb.code, redirect_uri: cb.redirectUri });
    if (!tokens || !tokens.access_token) throw new Error('Token exchange returned no access_token');
    // Identify the user (own /users needs no extra scope).
    let login = '', userId = '', displayName = '';
    try {
      const me = await helixRequest('GET', HELIX + '/users', tokens.access_token, null);
      const u = me && me.data && me.data.data && me.data.data[0];
      if (u) { login = u.login || ''; userId = u.id || ''; displayName = u.display_name || ''; }
    } catch (e) { /* identity is best-effort */ }
    const state = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at: tokens.expires_in ? (Date.now() + tokens.expires_in * 1000) : null,
      login: login, user_id: userId, display_name: displayName
    };
    writeState(state, role);
    const pub = publicStatus(state);
    emitStatus(pub, role);
    return pub;
  } finally { stopLoopbackServer(); }
}

function getStatus(role) { return publicStatus(readState(role)); }

async function signOut(role) { clearState(role); const pub = publicStatus(null); emitStatus(pub, role); return pub; }

// Send a chat message to `broadcasterId` AS the connected bot account (native
// Helix Send Chat Message). Requires the bot token (user:write:chat + user:bot)
// and the broadcaster having granted channel:bot (or the bot being a mod).
async function sendBotChat(broadcasterId, message) {
  const bs = readState('bot');
  if (!bs || !bs.access_token || !bs.user_id) return { ok: false, error: 'bot_not_connected' };
  if (!broadcasterId || !message) return { ok: false, error: 'missing_args' };
  try {
    const res = await helix('POST', 'chat/messages', '', { broadcaster_id: String(broadcasterId), sender_id: String(bs.user_id), message: String(message).slice(0, 500) }, 'bot');
    if (res.status >= 200 && res.status < 300) {
      const d = res.data && res.data.data && res.data.data[0];
      if (d && d.is_sent === false) return { ok: false, error: (d.drop_reason && (d.drop_reason.message || d.drop_reason.code)) || 'message dropped' };
      return { ok: true };
    }
    return { ok: false, error: (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status) };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// Create a clip on the broadcaster's own channel. Returns
// { ok, id?, editUrl?, error? }. Twitch requires the channel to be LIVE.
async function createClip() {
  const state = readState();
  if (!state || !state.access_token) return { ok: false, error: 'not_connected' };
  if (!state.user_id) return { ok: false, error: 'no_user_id' };
  try {
    const res = await helix('POST', 'clips', 'broadcaster_id=' + encodeURIComponent(state.user_id), null);
    const clip = res.data && res.data.data && res.data.data[0];
    if (res.status >= 200 && res.status < 300 && clip) {
      return { ok: true, id: clip.id, editUrl: clip.edit_url || ('https://clips.twitch.tv/' + clip.id + '/edit') };
    }
    // Common: 404 when offline, 401 when scope/token bad.
    const msg = (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status);
    return { ok: false, error: msg };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// ── IPC wiring ──────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  ipcMain.handle('twitch-begin-auth', async function () {
    try { return await beginAuth(); }
    catch (err) { return { signedIn: false, login: '', displayName: '', userId: '', error: err.message || String(err) }; }
  });
  ipcMain.handle('twitch-get-status', async function () { return getStatus(); });
  ipcMain.handle('twitch-sign-out',   async function () { return signOut(); });
  ipcMain.handle('twitch-create-clip', async function () { return createClip(); });
  // ── Optional bot account (second login, chat-send only) ──
  ipcMain.handle('twitch-bot-begin-auth', async function () {
    try { return await beginAuth('bot'); }
    catch (err) { return { signedIn: false, login: '', displayName: '', userId: '', error: err.message || String(err) }; }
  });
  ipcMain.handle('twitch-bot-get-status', async function () { return getStatus('bot'); });
  ipcMain.handle('twitch-bot-sign-out',   async function () { return signOut('bot'); });
  ipcMain.handle('twitch-bot-send-chat',  async function (event, payload) {
    const p = payload || {};
    return await sendBotChat(p.broadcasterId, p.message);
  });
  // Generic Helix passthrough for future direct-Helix features. Returns
  // { status, data }. The renderer only needs this for things SB can't do.
  ipcMain.handle('twitch-helix', async function (event, payload) {
    try {
      const p = payload || {};
      return await helix((p.method || 'GET').toUpperCase(), p.path || '', p.query || '', p.body || null);
    } catch (err) { return { status: 0, data: { error: err.message || String(err) } }; }
  });
}

// Raw access-token getters for main-process cloud calls (Stream Info
// Favorites sync). The token authenticates the user to aquilo cloud services
// the same way the Patreon token used to; it stays out of the renderer.
async function getRawAccessTokenAsync() {
  try { const s = await getValidToken(); return (s && s.access_token) || null; }
  catch (e) { return null; }
}
function getRawAccessToken() {
  try { const s = readState(); return (s && s.access_token) || null; }
  catch (e) { return null; }
}

module.exports = {
  registerIpcHandlers: registerIpcHandlers,
  setMainWindow: setMainWindow,
  getStatus: getStatus,
  beginAuth: beginAuth,
  signOut: signOut,
  createClip: createClip,
  helix: helix,
  getRawAccessTokenAsync: getRawAccessTokenAsync,
  getRawAccessToken: getRawAccessToken
};
