// Discord entitlement service for StreamFusion — a SECOND path to EA
// features alongside Patreon OAuth.
//
// Why: Patreon OAuth has known edge cases that lock out legitimate
// paying supporters:
//   - brand-new pledges in Patreon's status-sync window (minutes to
//     hours between successful first charge and patron_status flipping
//     to active_patron)
//   - Apple private-relay email signups where Patreon's internal state
//     stays `null` even longer
//   - Patreon API 5xx / rate-limit windows where verifyMembership fails
//
// In parallel, the aquilo.gg Discord server already assigns Tier 2 /
// Tier 3 Patron roles automatically when supporters connect their
// Patreon to Discord (built-in Patreon ↔ Discord integration). Those
// role assignments are durable and don't suffer from the above bugs.
// So: let the user Connect Discord in SF, check for those roles,
// grant EA access via that path too. Either path works.
//
// Responsibilities (mirror patreon-auth.js shape so main.js can wire
// this up the same way):
//   1. Start Discord OAuth flow in the user's system browser; catch
//      the callback on a local loopback server (CSRF-protected state).
//   2. Exchange the authorization code for tokens through the shared
//      Cloudflare Worker (POST /discord-token) so client_secret never
//      ships in the app binary.
//   3. Call Discord's GET /users/@me/guilds/{GUILD_ID}/member with the
//      user's access token to read their role IDs in the aquilo.gg
//      guild. Check for Tier 2 or Tier 3 Patron role IDs.
//   4. Persist the result (safeStorage-encrypted) so we don't OAuth
//      every launch. Re-check hourly while running + on-launch if
//      cache is >24h old.
//   5. Emit a `discord-entitlement-changed` IPC message to the main
//      window on state changes. main-process subscribers can register
//      via onEntitlementChange (e.g. obs-server flipping its gate).
//
// Public entitlement shape (what getEntitlement returns, also the
// payload of the IPC event):
//   {
//     signedIn:     bool,    // Discord token is cached
//     entitled:     bool,    // signedIn AND has Tier 2 or Tier 3 role
//                            //   in the configured guild
//     tier:         'tier3' | 'tier2' | 'none',
//     reason:       'entitled' | 'no_role' | 'not_in_guild'
//                 | 'reverify_failed' | 'not_signed_in' | 'unknown',
//     userName:     string,  // Discord global_name or username,
//                            //   blank when signed out
//     userId:       string,  // Discord user snowflake (for logs)
//     verifiedAt:   number | null
//   }
//
// Renderer: treat Discord.entitled OR Patreon.entitled as the EA gate.
// index.html's applyPatreonState / applyDiscordState both update
// S.hasEarlyAccess = S.patreon.entitled || S.discord.entitled.

'use strict';

const { shell, safeStorage, ipcMain, app, BrowserWindow } = require('electron');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
// OAuth client credentials. PUBLIC client_id is safe to ship; client_secret
// lives on the Cloudflare Worker. The StreamFusion Discord bot's
// application ID (the same one used for the bot) doubles as the OAuth
// client — one Discord application can host both a bot and an OAuth
// client. Set up the redirect URIs on discord.com/developers under
// the StreamFusion application → OAuth2 → Redirects.
//
// Required redirect URIs (add ALL on the Discord dev portal —
// discord.com/developers/applications → StreamFusion → OAuth2 →
// Redirects). Discord REJECTS bare IP addresses like 127.0.0.1 in
// OAuth redirects even though Patreon accepts them, so these MUST
// use the literal hostname `localhost`:
//   http://localhost:17826/callback
//   http://localhost:17827/callback
//   http://localhost:17828/callback
// The loopback server still binds to 127.0.0.1; the browser's
// hosts-file lookup resolves `localhost` → 127.0.0.1 so the socket
// connection works transparently. We try ports in order at runtime
// (same pattern as patreon-auth.js) so a conflicting dev server on
// 17826 doesn't block sign-in.
const DISCORD_CLIENT_ID = process.env.SF_DISCORD_CLIENT_ID || '1494759611922645003';

// Guild we check membership + roles against. This is aquilo.gg Discord.
const DISCORD_GUILD_ID  = process.env.SF_DISCORD_GUILD_ID  || '1334146273854619709';

// Role IDs assigned by Patreon ↔ Discord integration when supporters
// connect their Patreon and pledge. Tier 3 takes precedence over
// Tier 2 when both are present.
const DISCORD_ROLE_IDS = {
  tier2: process.env.SF_DISCORD_TIER2_ROLE_ID || '1482092449609420982',
  tier3: process.env.SF_DISCORD_TIER3_ROLE_ID || '1483242263961407670'
};

// Shared Cloudflare Worker. The /discord-token endpoint exchanges an
// authorization code for access / refresh tokens, injecting the
// Discord client_secret server-side.
const TOKEN_PROXY_URL = process.env.SF_TOKEN_PROXY_URL || 'https://streamfusion-patreon-proxy.bisherclay.workers.dev/';

const LOOPBACK_PORTS = [17826, 17827, 17828];
const SCOPES = ['identify', 'guilds.members.read'];

const REVERIFY_INTERVAL_MS =      24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS     = 7 * 24 * 60 * 60 * 1000;
const RUNTIME_CHECK_MS     =           60 * 60 * 1000;

// Schema version on the persisted state — bump when the entitlement
// decision logic changes in a way that could flip an existing user's
// cached result. Forces an immediate reverify on first launch after
// the app update lands. Mirrors the pattern in patreon-auth.js.
const STATE_SCHEMA_V = 1;

// ── State ────────────────────────────────────────────────────────────────────
let authResolver = null;
let loopbackServer = null;
let expectedState = null;
let runtimeCheckTimer = null;
let mainWindowRef = null;
let lastEmittedEntitlement = null;
let entitlementCallbacks = [];

// ── Persistence (safeStorage-encrypted) ──────────────────────────────────────
function statePath() { return path.join(app.getPath('userData'), 'discord-auth.json'); }

function writeState(obj) {
  try {
    obj.schema_v = STATE_SCHEMA_V;
    var json = JSON.stringify(obj);
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      var enc = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(statePath(), JSON.stringify({ v: 1, enc: enc }), 'utf8');
    } else {
      fs.writeFileSync(statePath(), JSON.stringify({ v: 1, raw: obj }), 'utf8');
    }
  } catch (e) {
    console.error('[discord-auth] writeState failed:', e);
  }
}

function readState() {
  try {
    var raw = fs.readFileSync(statePath(), 'utf8');
    var parsed = JSON.parse(raw);
    if (parsed.enc && safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      var buf = Buffer.from(parsed.enc, 'base64');
      return JSON.parse(safeStorage.decryptString(buf));
    }
    if (parsed.raw) return parsed.raw;
    return null;
  } catch (e) { return null; }
}

function clearState() {
  try { fs.unlinkSync(statePath()); } catch (e) {}
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function postJson(url, body) {
  return new Promise(function(resolve, reject) {
    var u = new URL(url);
    var data = typeof body === 'string' ? body : JSON.stringify(body);
    var req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      port: u.port || 443,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'StreamFusion'
      }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString('utf8');
        try {
          var json = JSON.parse(text);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode, body: json }));
        } catch (e) {
          reject(Object.assign(new Error('Non-JSON response'), { status: res.statusCode, body: text }));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('Token exchange timed out')); });
    req.write(data);
    req.end();
  });
}

function getJson(url, accessToken) {
  return new Promise(function(resolve, reject) {
    var u = new URL(url);
    var req = https.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      port: u.port || 443,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'User-Agent': 'StreamFusion'
      }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString('utf8');
        try {
          var json = JSON.parse(text);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode, body: json }));
        } catch (e) {
          reject(Object.assign(new Error('Non-JSON response'), { status: res.statusCode, body: text }));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

async function exchangeCode(code, redirectUri) {
  // Worker is shared with Patreon. Endpoint distinguishes by path.
  var u = new URL(TOKEN_PROXY_URL);
  u.pathname = (u.pathname.replace(/\/+$/, '') + '/discord-token').replace(/^\/+/, '/');
  return postJson(u.toString(), {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri
  });
}

async function refreshTokens(refreshToken) {
  var u = new URL(TOKEN_PROXY_URL);
  u.pathname = (u.pathname.replace(/\/+$/, '') + '/discord-token').replace(/^\/+/, '/');
  return postJson(u.toString(), {
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
}

// ── Core verification ────────────────────────────────────────────────────────
// Given an access token, fetch the user's roles in the configured guild
// and decide tier + entitlement. The `guilds.members.read` scope grants
// access to /users/@me/guilds/{guild_id}/member which returns the
// full member object (roles + nick + joined_at, etc.) for the user
// in just that one guild. Requires the bot to be in that guild too.
async function verifyMembership(accessToken) {
  var userName = '';
  var userId   = '';

  // Step 1: user identity (for UI "Connected as @..." + diagnostics)
  try {
    var me = await getJson('https://discord.com/api/v10/users/@me', accessToken);
    userName = me.global_name || me.username || '';
    userId   = me.id || '';
  } catch (e) {
    console.warn('[discord-auth] verify: /users/@me failed:', e && e.message);
    // Don't abort — try the guild lookup anyway. Discord returns 401 on
    // expired tokens which the caller handles via offline_grace / stale.
  }

  // Step 2: member record in the configured guild. 404 = not in guild.
  var memberResp;
  try {
    memberResp = await getJson(
      'https://discord.com/api/v10/users/@me/guilds/' + encodeURIComponent(DISCORD_GUILD_ID) + '/member',
      accessToken);
  } catch (e) {
    if (e && e.status === 404) {
      console.log('[discord-auth] verify: user ' + (userId || 'unknown') + ' (@' + (userName || '?') + ') is not in guild ' + DISCORD_GUILD_ID);
      return { active: false, entitled: false, tier: 'none', reason: 'not_in_guild', userName: userName, userId: userId };
    }
    // Rethrow other errors so caller can run offline_grace / stale logic.
    throw e;
  }

  var roleIds = (memberResp && memberResp.roles) || [];
  if (!Array.isArray(roleIds)) roleIds = [];
  // Coerce to strings (Discord API returns strings per snowflake spec,
  // but be defensive against any client-side deserialization that
  // turned them into numbers).
  roleIds = roleIds.map(function(r) { return String(r); });

  var tier3Id = String(DISCORD_ROLE_IDS.tier3);
  var tier2Id = String(DISCORD_ROLE_IDS.tier2);
  var hasTier3 = roleIds.indexOf(tier3Id) !== -1;
  var hasTier2 = roleIds.indexOf(tier2Id) !== -1;

  var tier = hasTier3 ? 'tier3' : hasTier2 ? 'tier2' : 'none';
  var entitled = hasTier2 || hasTier3;
  var reason;
  if (entitled) reason = 'entitled';
  else reason = 'no_role';

  if (entitled) {
    console.log('[discord-auth] verify: user ' + userId + ' (@' + userName + ') granted ' + tier + ' via Discord role');
  } else {
    console.log('[discord-auth] verify: user ' + userId + ' (@' + userName + ') has no Patron role in guild. roles=' + JSON.stringify(roleIds));
  }

  return { active: entitled, entitled: entitled, tier: tier, reason: reason, userName: userName, userId: userId };
}

// ── Loopback server for OAuth redirect ───────────────────────────────────────
function startLoopbackServer() {
  return new Promise(function(resolve, reject) {
    var attempts = LOOPBACK_PORTS.slice();
    function tryNext() {
      if (!attempts.length) {
        reject(new Error('No loopback port available (tried: ' + LOOPBACK_PORTS.join(', ') + ')'));
        return;
      }
      var port = attempts.shift();
      var srv = http.createServer(function(req, res) {
        if (!req.url) { res.writeHead(400); res.end('Bad request'); return; }
        var u = new URL(req.url, 'http://localhost:' + port);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end('Not found'); return; }
        var code = u.searchParams.get('code');
        var state = u.searchParams.get('state');
        var errParam = u.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (errParam) {
          res.end('<html><body style="font-family:sans-serif;background:#0e0e10;color:#e6e6f0;padding:40px"><h2>Discord sign-in cancelled</h2><p>You can close this tab and return to StreamFusion.</p></body></html>');
        } else {
          res.end('<html><body style="font-family:sans-serif;background:#0e0e10;color:#e6e6f0;padding:40px"><h2>You\'re connected!</h2><p>You can close this tab and return to StreamFusion.</p><script>setTimeout(function(){window.close()},1500)</script></body></html>');
        }

        if (authResolver) {
          if (errParam) authResolver.reject(new Error('OAuth error: ' + errParam));
          else if (!state || state !== expectedState) authResolver.reject(new Error('OAuth state mismatch (possible CSRF)'));
          else if (!code) authResolver.reject(new Error('OAuth callback missing code'));
          else authResolver.resolve({ code: code, redirectUri: 'http://localhost:' + port + '/callback' });
          authResolver = null;
        }
      });
      srv.on('error', function(err) {
        if (err && err.code === 'EADDRINUSE') { tryNext(); return; }
        reject(err);
      });
      srv.listen(port, '127.0.0.1', function() {
        loopbackServer = srv;
        resolve(port);
      });
    }
    tryNext();
  });
}

function stopLoopbackServer() {
  if (loopbackServer) {
    try { loopbackServer.close(); } catch (e) {}
    loopbackServer = null;
  }
}

// ── Event emission ───────────────────────────────────────────────────────────
function setMainWindow(win) { mainWindowRef = win; }

function buildPublicState(state) {
  if (!state) return { signedIn: false, entitled: false, tier: 'none', reason: 'not_signed_in', userName: '', userId: '', verifiedAt: null };
  return {
    signedIn:   !!state.access_token,
    entitled:   !!state.entitled,
    tier:       state.tier || 'none',
    reason:     state.reason || 'unknown',
    userName:   state.userName || '',
    userId:     state.userId   || '',
    verifiedAt: state.verified_at || null
  };
}

function emitEntitlement(publicState) {
  try {
    var key = JSON.stringify({
      s: publicState.signedIn, e: publicState.entitled, t: publicState.tier, r: publicState.reason
    });
    if (key === lastEmittedEntitlement) return;
    lastEmittedEntitlement = key;
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('discord-entitlement-changed', publicState);
    }
    for (var i = 0; i < entitlementCallbacks.length; i++) {
      try { entitlementCallbacks[i](publicState); } catch (cbErr) {
        console.error('[discord-auth] entitlement callback threw:', cbErr);
      }
    }
  } catch (e) { /* non-fatal */ }
}

function onEntitlementChange(cb) {
  if (typeof cb !== 'function') return function() {};
  entitlementCallbacks.push(cb);
  return function unsubscribe() {
    var i = entitlementCallbacks.indexOf(cb);
    if (i !== -1) entitlementCallbacks.splice(i, 1);
  };
}

// ── Public flow ──────────────────────────────────────────────────────────────
async function beginAuth() {
  stopLoopbackServer();
  var port = await startLoopbackServer();
  var redirectUri = 'http://localhost:' + port + '/callback';
  expectedState = crypto.randomBytes(16).toString('hex');

  var authUrl = 'https://discord.com/api/oauth2/authorize' +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(DISCORD_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&scope=' + encodeURIComponent(SCOPES.join(' ')) +
    '&state=' + expectedState +
    // prompt=consent forces Discord to re-show the consent screen even
    // if the user authorized StreamFusion for their account before.
    // Useful for debugging + lets the user see exactly what we request.
    '&prompt=none';

  var codePromise = new Promise(function(resolve, reject) {
    authResolver = { resolve: resolve, reject: reject };
    setTimeout(function() {
      if (authResolver) {
        authResolver.reject(new Error('Sign-in timed out after 5 minutes'));
        authResolver = null;
      }
    }, 5 * 60 * 1000);
  });

  shell.openExternal(authUrl);

  try {
    var callback = await codePromise;
    var tokens = await exchangeCode(callback.code, callback.redirectUri);
    if (!tokens || !tokens.access_token) throw new Error('Token exchange returned no access_token');

    var verify = await verifyMembership(tokens.access_token);
    var state = {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at:    tokens.expires_in ? (Date.now() + tokens.expires_in * 1000) : null,
      verified_at:   Date.now(),
      entitled:      verify.entitled,
      tier:          verify.tier,
      reason:        verify.reason,
      userName:      verify.userName,
      userId:        verify.userId
    };
    writeState(state);
    var pub = buildPublicState(state);
    emitEntitlement(pub);
    startRuntimeChecks();
    return pub;
  } finally {
    stopLoopbackServer();
  }
}

async function getEntitlement() {
  var state = readState();
  if (!state || !state.access_token) {
    var pub = buildPublicState(null);
    emitEntitlement(pub);
    return pub;
  }

  var age = Date.now() - (state.verified_at || 0);
  var needsReverify = age > REVERIFY_INTERVAL_MS;
  if (!state.schema_v || state.schema_v < STATE_SCHEMA_V) {
    console.log('[discord-auth] cached state schema_v=' + (state.schema_v || 'missing') + ' < ' + STATE_SCHEMA_V + ' — forcing reverify');
    needsReverify = true;
  }

  if (!needsReverify) {
    var cached = buildPublicState(state);
    emitEntitlement(cached);
    return cached;
  }

  try {
    if (state.expires_at && Date.now() >= state.expires_at && state.refresh_token) {
      try {
        var refreshed = await refreshTokens(state.refresh_token);
        if (refreshed && refreshed.access_token) {
          state.access_token  = refreshed.access_token;
          state.refresh_token = refreshed.refresh_token || state.refresh_token;
          state.expires_at    = refreshed.expires_in ? (Date.now() + refreshed.expires_in * 1000) : null;
        }
      } catch (refreshErr) { /* fall through — verifyMembership 401 will land us in stale path */ }
    }

    var verify = await verifyMembership(state.access_token);
    state.verified_at  = Date.now();
    state.entitled     = verify.entitled;
    state.tier         = verify.tier;
    state.reason       = verify.reason;
    state.userName     = verify.userName;
    state.userId       = verify.userId;
    writeState(state);
    var pub2 = buildPublicState(state);
    emitEntitlement(pub2);
    return pub2;
  } catch (err) {
    console.warn('[discord-auth] reverify failed:', err && err.message);
    if (state.entitled && age < OFFLINE_GRACE_MS) {
      var graceState = Object.assign({}, state, { reason: 'offline_grace' });
      var grace = buildPublicState(graceState);
      emitEntitlement(grace);
      return grace;
    }
    var staleState = Object.assign({}, state, { entitled: false, reason: 'reverify_failed' });
    var stale = buildPublicState(staleState);
    emitEntitlement(stale);
    return stale;
  }
}

async function signOut() {
  clearState();
  stopRuntimeChecks();
  var pub = buildPublicState(null);
  lastEmittedEntitlement = null;
  emitEntitlement(pub);
  return pub;
}

function startRuntimeChecks() {
  if (runtimeCheckTimer) clearInterval(runtimeCheckTimer);
  runtimeCheckTimer = setInterval(function() {
    getEntitlement().catch(function(e) { /* swallowed */ });
  }, RUNTIME_CHECK_MS);
}

function stopRuntimeChecks() {
  if (runtimeCheckTimer) {
    clearInterval(runtimeCheckTimer);
    runtimeCheckTimer = null;
  }
}

// ── IPC wiring ──────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  ipcMain.handle('discord-begin-auth', async function() {
    try { return await beginAuth(); }
    catch (err) {
      return { signedIn: false, entitled: false, tier: 'none', reason: 'error', error: err.message || String(err), userName: '', userId: '' };
    }
  });
  ipcMain.handle('discord-get-entitlement', async function() { return getEntitlement(); });
  ipcMain.handle('discord-sign-out',        async function() { return signOut(); });
}

module.exports = {
  registerIpcHandlers:  registerIpcHandlers,
  setMainWindow:        setMainWindow,
  getEntitlement:       getEntitlement,
  beginAuth:            beginAuth,
  signOut:              signOut,
  startRuntimeChecks:   startRuntimeChecks,
  stopRuntimeChecks:    stopRuntimeChecks,
  onEntitlementChange:  onEntitlementChange
};
