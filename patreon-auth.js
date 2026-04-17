// Patreon entitlement service for StreamFusion.
//
// This module is NOT a gate. The app boots normally for everyone; signing in
// with Patreon is optional and only unlocks Early Access (EA) features for
// users with an active membership on Tier 2 or Tier 3 of the StreamFusion
// campaign.
//
// Responsibilities:
//   1. Start the OAuth flow when the renderer asks (onboarding or settings).
//      Patreon auth happens in the user's system browser; we catch the
//      callback via a loopback HTTP server.
//   2. Exchange the authorization code for tokens through a Cloudflare
//      Worker (patreon-proxy.worker.js) so the client secret is never in
//      the app binary.
//   3. Verify membership against the configured campaign, and check that
//      the user is currently entitled to Tier 2 or Tier 3. Persist the
//      result (encrypted at rest via Electron safeStorage / DPAPI).
//   4. Re-check periodically (hourly while the app runs, and on every
//      launch). Cancellations propagate to EA-lock within ~1 hour.
//   5. Emit a `patreon-entitlement-changed` IPC message to the main window
//      whenever the entitlement state changes, so the renderer can show or
//      hide EA features live without a restart.
//
// Entitlement model:
//   signedIn     bool   — user has a token cached
//   entitled     bool   — signedIn AND active_patron AND tier ∈ {tier2, tier3}
//   tier         string — 'tier3' | 'tier2' | 'tier1' | 'follower' | 'none'
//   patronStatus string — raw patron_status from Patreon, or null
//   reason       string — short code for UI messaging
//   userName     string — full_name from Patreon, for "Connected as ..."
//
// The renderer should treat `entitled === true` as the sole gate for EA
// features; `signedIn && !entitled` means "connected, but not at a high
// enough tier yet" and warrants an upsell message.

'use strict';

const { shell, safeStorage, ipcMain, app, BrowserWindow } = require('electron');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
// Fill these in after registering your Patreon OAuth client at
// https://www.patreon.com/portal/registration/register-clients
//
// PATREON_CLIENT_ID     — public; safe to ship in the binary
// PATREON_CAMPAIGN_ID   — public; safe to ship
// PATREON_TIER_IDS      — tier IDs for Tier 2 and Tier 3 on your campaign.
//                         Find them via the Patreon API:
//                         GET /api/oauth2/v2/campaigns/{campaign_id}?include=tiers
//                         See SETUP-PATREON.md for the full walkthrough.
// TOKEN_PROXY_URL       — your deployed Cloudflare Worker endpoint
//
// REDIRECT URIs you must register on your Patreon OAuth client page:
//   http://127.0.0.1:17823/callback
//   http://127.0.0.1:17824/callback
//   http://127.0.0.1:17825/callback
// Public values — safe to commit. Verified against Patreon /campaigns API.
//   Tier 2 │ Early Access  → tier id 28147937 ($6)
//   Tier 3 │ Contributor   → tier id 28147942 ($10)
const PATREON_CLIENT_ID   = process.env.SF_PATREON_CLIENT_ID   || 'tPN89A6Yz_NEpvQIQ2hDXcfCpyrrYha6YsgZ-aUcQP2y8Lcnaxm7-xSY8W3Zn4QO';
const PATREON_CAMPAIGN_ID = process.env.SF_PATREON_CAMPAIGN_ID || '3410750';
const PATREON_TIER_IDS = {
  tier2: process.env.SF_PATREON_TIER2_ID || '28147937',
  tier3: process.env.SF_PATREON_TIER3_ID || '28147942'
};
// Cloudflare Worker that proxies Patreon's token endpoint and adds the
// client_secret server-side. Source: patreon-proxy.worker.js in this repo.
const TOKEN_PROXY_URL     = process.env.SF_TOKEN_PROXY_URL     || 'https://streamfusion-patreon-proxy.bisherclay.workers.dev/';

const LOOPBACK_PORTS = [17823, 17824, 17825];
const SCOPES = ['identity', 'identity.memberships'];

// Owner account — always entitled regardless of Patreon membership state.
const OWNER_EMAILS = ['bisherclay@gmail.com'];

const REVERIFY_INTERVAL_MS =      24 * 60 * 60 * 1000;  // stale-cache threshold: reverify on next launch after 24h
const OFFLINE_GRACE_MS     = 7 * 24 * 60 * 60 * 1000;   // honor cached "ok" for 7d if Patreon is unreachable
const RUNTIME_CHECK_MS     =           60 * 60 * 1000;  // periodic reverify while running: every 1h

// ── State ────────────────────────────────────────────────────────────────────
let authResolver = null;         // { resolve, reject } for the in-flight auth flow
let loopbackServer = null;
let expectedState = null;        // OAuth `state` for CSRF defense
let runtimeCheckTimer = null;
let mainWindowRef = null;        // set by main.js via setMainWindow()
let lastEmittedEntitlement = null;

// ── Persistence (safeStorage-encrypted) ──────────────────────────────────────
function statePath() { return path.join(app.getPath('userData'), 'patreon-auth.json'); }

function writeState(obj) {
  try {
    var json = JSON.stringify(obj);
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      var enc = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(statePath(), JSON.stringify({ v: 1, enc: enc }), 'utf8');
    } else {
      // Fallback — plaintext in userData. Same trust level as the rest of
      // the app's storage; not ideal, but not worse than anything else.
      fs.writeFileSync(statePath(), JSON.stringify({ v: 1, raw: obj }), 'utf8');
    }
  } catch (e) {
    console.error('[patreon-auth] writeState failed:', e);
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
  return postJson(TOKEN_PROXY_URL, {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri
  });
}

async function refreshTokens(refreshToken) {
  return postJson(TOKEN_PROXY_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
}

// ── Core verification ────────────────────────────────────────────────────────
// Given an access token, figure out the user's current relationship to our
// campaign. Returns a rich object — the renderer uses this to decide between
// "unlocked", "upgrade to Tier 2+", "re-pledge your expired membership", etc.
//
// The tier ranking (tier3 > tier2 > tier1 > follower > none) is used for a
// single purpose: if the user pledges to multiple tiers on our campaign (which
// happens rarely but is possible), we report the highest one they're entitled to.
async function verifyMembership(accessToken) {
  var url = 'https://www.patreon.com/api/oauth2/v2/identity' +
    '?include=memberships,memberships.currently_entitled_tiers' +
    '&fields%5Buser%5D=full_name,email' +
    '&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents,is_follower' +
    '&fields%5Btier%5D=title,amount_cents';

  var data = await getJson(url, accessToken);

  var userName = (data && data.data && data.data.attributes && data.data.attributes.full_name) || '';
  var userEmail = (data && data.data && data.data.attributes && data.data.attributes.email) || '';

  // Owner bypass — always grant full access
  if (userEmail && OWNER_EMAILS.indexOf(userEmail.toLowerCase()) !== -1) {
    return { active: true, entitled: true, tier: 'tier3', patronStatus: 'active_patron', reason: 'entitled', userName: userName };
  }

  if (!data || !data.included) {
    return { active: false, entitled: false, tier: 'none', patronStatus: null, reason: 'no_memberships', userName: userName };
  }

  // Membership records (type=member) include a relationship to the campaign
  // and a relationship to `currently_entitled_tiers`. Find the membership
  // record for our campaign; read its tier IDs.
  var memberships = data.included.filter(function(i) { return i.type === 'member'; });
  var myMembership = null;
  for (var i = 0; i < memberships.length; i++) {
    var rel = memberships[i].relationships || {};
    // Some Patreon API responses nest campaign under .data, some older ones
    // put it directly — handle both defensively.
    var camp = rel.campaign && rel.campaign.data;
    if (camp && camp.id === PATREON_CAMPAIGN_ID) {
      myMembership = memberships[i];
      break;
    }
  }

  if (!myMembership) {
    return { active: false, entitled: false, tier: 'follower', patronStatus: null, reason: 'not_a_member', userName: userName };
  }

  var patronStatus = (myMembership.attributes && myMembership.attributes.patron_status) || null;
  var entitledTierIds = ((myMembership.relationships &&
                          myMembership.relationships.currently_entitled_tiers &&
                          myMembership.relationships.currently_entitled_tiers.data) || [])
                        .map(function(t) { return t.id; });

  var hasTier3 = entitledTierIds.indexOf(PATREON_TIER_IDS.tier3) !== -1;
  var hasTier2 = entitledTierIds.indexOf(PATREON_TIER_IDS.tier2) !== -1;
  var tier = hasTier3 ? 'tier3'
           : hasTier2 ? 'tier2'
           : entitledTierIds.length > 0 ? 'tier1'
           : 'follower';

  var active = patronStatus === 'active_patron';
  var entitled = active && (hasTier2 || hasTier3);

  var reason;
  if (entitled) reason = 'entitled';
  else if (!active && patronStatus) reason = patronStatus;   // declined_patron, former_patron, etc.
  else if (!active) reason = 'follower';
  else reason = 'insufficient_tier';  // active, but on Tier 1 or lower

  return { active: active, entitled: entitled, tier: tier, patronStatus: patronStatus, reason: reason, userName: userName };
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
        var u = new URL(req.url, 'http://127.0.0.1:' + port);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end('Not found'); return; }
        var code = u.searchParams.get('code');
        var state = u.searchParams.get('state');
        var errParam = u.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (errParam) {
          res.end('<html><body style="font-family:sans-serif;background:#0e0e10;color:#e6e6f0;padding:40px"><h2>Sign-in cancelled</h2><p>You can close this tab and return to StreamFusion.</p></body></html>');
        } else {
          res.end('<html><body style="font-family:sans-serif;background:#0e0e10;color:#e6e6f0;padding:40px"><h2>You\'re signed in!</h2><p>You can close this tab and return to StreamFusion.</p><script>setTimeout(function(){window.close()},1500)</script></body></html>');
        }

        if (authResolver) {
          if (errParam) authResolver.reject(new Error('OAuth error: ' + errParam));
          else if (!state || state !== expectedState) authResolver.reject(new Error('OAuth state mismatch (possible CSRF)'));
          else if (!code) authResolver.reject(new Error('OAuth callback missing code'));
          else authResolver.resolve({ code: code, redirectUri: 'http://127.0.0.1:' + port + '/callback' });
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
  // Shape we expose to the renderer. Does NOT include tokens — just the
  // entitlement summary and human-readable metadata.
  if (!state) return { signedIn: false, entitled: false, tier: 'none', patronStatus: null, reason: 'not_signed_in', userName: '' };
  return {
    signedIn: !!state.access_token,
    entitled: !!state.entitled,
    tier: state.tier || 'none',
    patronStatus: state.patronStatus || null,
    reason: state.reason || 'unknown',
    userName: state.userName || '',
    verifiedAt: state.verified_at || null
  };
}

function emitEntitlement(publicState) {
  try {
    // Deduplicate — only emit when the summary actually changes.
    var key = JSON.stringify({
      s: publicState.signedIn, e: publicState.entitled, t: publicState.tier, r: publicState.reason
    });
    if (key === lastEmittedEntitlement) return;
    lastEmittedEntitlement = key;
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('patreon-entitlement-changed', publicState);
    }
  } catch (e) { /* non-fatal */ }
}

// ── Public flow ──────────────────────────────────────────────────────────────

// Start the interactive sign-in flow. Returns the public entitlement state
// when done. Never throws for "user cancelled" — returns { signedIn:false,
// reason:'cancelled' }. Throws for genuine errors (network, misconfig).
async function beginAuth() {
  stopLoopbackServer();
  var port = await startLoopbackServer();
  var redirectUri = 'http://127.0.0.1:' + port + '/callback';
  expectedState = crypto.randomBytes(16).toString('hex');

  var authUrl = 'https://www.patreon.com/oauth2/authorize' +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(PATREON_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&scope=' + encodeURIComponent(SCOPES.join(' ')) +
    '&state=' + expectedState;

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
      patronStatus:  verify.patronStatus,
      reason:        verify.reason,
      userName:      verify.userName
    };
    writeState(state);
    var pub = buildPublicState(state);
    emitEntitlement(pub);
    // Kick off runtime checks now that the user is signed in.
    startRuntimeChecks();
    return pub;
  } finally {
    stopLoopbackServer();
  }
}

// Return the current entitlement state. Uses cache when fresh; reverifies
// against Patreon when stale (>24h); respects offline grace on network errors.
async function getEntitlement() {
  var state = readState();
  if (!state || !state.access_token) {
    var pub = buildPublicState(null);
    emitEntitlement(pub);
    return pub;
  }

  var age = Date.now() - (state.verified_at || 0);
  var needsReverify = age > REVERIFY_INTERVAL_MS;

  if (!needsReverify) {
    var cached = buildPublicState(state);
    emitEntitlement(cached);
    return cached;
  }

  // Time to reverify. Refresh the access token first if it has expired.
  try {
    if (state.expires_at && Date.now() >= state.expires_at && state.refresh_token) {
      try {
        var refreshed = await refreshTokens(state.refresh_token);
        if (refreshed && refreshed.access_token) {
          state.access_token  = refreshed.access_token;
          state.refresh_token = refreshed.refresh_token || state.refresh_token;
          state.expires_at    = refreshed.expires_in ? (Date.now() + refreshed.expires_in * 1000) : null;
        }
      } catch (refreshErr) {
        // Fall through to verifyMembership, which will likely fail and
        // force the user to re-auth.
      }
    }

    var verify = await verifyMembership(state.access_token);
    state.verified_at  = Date.now();
    state.entitled     = verify.entitled;
    state.tier         = verify.tier;
    state.patronStatus = verify.patronStatus;
    state.reason       = verify.reason;
    state.userName     = verify.userName;
    writeState(state);
    var pub2 = buildPublicState(state);
    emitEntitlement(pub2);
    return pub2;

  } catch (err) {
    // Network/API failure during reverify. Apply offline grace only if the
    // cached state was previously entitled — don't grant access we never had.
    if (state.entitled && age < OFFLINE_GRACE_MS) {
      var graceState = Object.assign({}, state, { reason: 'offline_grace' });
      var grace = buildPublicState(graceState);
      emitEntitlement(grace);
      return grace;
    }
    // Past the grace window, or never was entitled — report as stale.
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
  lastEmittedEntitlement = null; // force re-emit
  emitEntitlement(pub);
  return pub;
}

// ── Periodic runtime check ──────────────────────────────────────────────────
function startRuntimeChecks() {
  if (runtimeCheckTimer) clearInterval(runtimeCheckTimer);
  runtimeCheckTimer = setInterval(function() {
    // getEntitlement already emits on change, which is what the renderer needs.
    getEntitlement().catch(function(e) { /* swallowed — next tick will retry */ });
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
  ipcMain.handle('patreon-begin-auth', async function() {
    try {
      return await beginAuth();
    } catch (err) {
      return { signedIn: false, entitled: false, tier: 'none', reason: 'error', error: err.message || String(err), userName: '' };
    }
  });
  ipcMain.handle('patreon-get-entitlement', async function() {
    return getEntitlement();
  });
  ipcMain.handle('patreon-sign-out', async function() {
    return signOut();
  });
}

module.exports = {
  registerIpcHandlers: registerIpcHandlers,
  setMainWindow:       setMainWindow,
  getEntitlement:      getEntitlement,
  beginAuth:           beginAuth,
  signOut:             signOut,
  startRuntimeChecks:  startRuntimeChecks,
  stopRuntimeChecks:   stopRuntimeChecks
};
