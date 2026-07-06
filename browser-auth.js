// browser-auth.js — StreamFusion multi-platform sign-in via the SYSTEM browser.
//
// Streamers are usually already logged into Twitch / Kick / YouTube in their
// default browser, so instead of an in-app login window we open the browser to
// the aquilo.gg broker (which holds the client secrets), then POLL the broker
// for the resulting token. No loopback server, no client secret on the desktop,
// and it reuses the broker's already-registered redirect URIs — nothing new to
// register per platform. See patreon-proxy.worker.js → /desktop/login +
// /desktop/token. Retrieval is bound to a PKCE verifier the app keeps private,
// so the nonce (visible in the browser URL) can't be replayed to lift the token.
//
// This complements twitch-auth.js (which uses a loopback flow): use this for
// Kick + YouTube, and Twitch too if you prefer the no-loopback path.

const { shell, safeStorage, ipcMain, app } = require('electron');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BROKER = process.env.SF_AUTH_BROKER_URL || 'https://auth.aquilo.gg';
const PLATFORMS = ['kick', 'youtube', 'twitch'];
const POLL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000;

let mainWindowRef = null;
function setMainWindow(win) { mainWindowRef = win; }

// ── persistence (per platform+role, safeStorage-encrypted like twitch-auth) ──
function statePath(platform, role) {
  const suffix = role === 'bot' ? '-bot' : '';
  return path.join(app.getPath('userData'), platform + suffix + '-auth.json');
}
function writeState(platform, role, obj) {
  try {
    const j = JSON.stringify(obj);
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(statePath(platform, role), JSON.stringify({ v: 1, enc: safeStorage.encryptString(j).toString('base64') }), 'utf8');
    } else {
      fs.writeFileSync(statePath(platform, role), JSON.stringify({ v: 1, raw: obj }), 'utf8');
    }
  } catch (e) { console.error('[browser-auth] writeState', platform, e); }
}
function readState(platform, role) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(platform, role), 'utf8'));
    if (parsed.enc && safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.enc, 'base64')));
    }
    return parsed.raw || null;
  } catch (e) { return null; }
}
function clearState(platform, role) { try { fs.unlinkSync(statePath(platform, role)); } catch (e) {} }

// ── status ───────────────────────────────────────────────────────────────────
function publicStatus(state) {
  if (!state || !state.access_token) return { signedIn: false, login: '', displayName: '', userId: '' };
  const id = state.identity || {};
  return { signedIn: true, login: id.login || '', displayName: id.display_name || '', userId: id.id || '' };
}
function emitStatus(platform, role, status) {
  try {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('platform-status-changed', { platform: platform, role: role, status: status });
    }
  } catch (e) { /* non-fatal */ }
}

// ── PKCE (the app's private verifier binds the token poll) ───────────────────
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier: verifier, challenge: challenge };
}

function getJson(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad-json')); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
  });
}

// ── flow ─────────────────────────────────────────────────────────────────────
async function beginAuth(platform, role) {
  if (PLATFORMS.indexOf(platform) < 0) throw new Error('Unsupported platform: ' + platform);
  role = role === 'bot' ? 'bot' : 'broadcaster';
  const session = crypto.randomBytes(24).toString('hex'); // nonce (rides in the browser URL)
  const pk = pkcePair();                                  // verifier stays in this process
  const loginUrl = BROKER + '/desktop/login?platform=' + encodeURIComponent(platform)
    + '&session=' + session + '&challenge=' + pk.challenge + '&mode=' + role;
  shell.openExternal(loginUrl); // hand off to the streamer's default browser

  const tokenUrl = BROKER + '/desktop/token?session=' + session + '&verifier=' + pk.verifier;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, POLL_MS); });
    let resp;
    try { resp = await getJson(tokenUrl); } catch (e) { continue; } // transient — keep polling
    if (!resp || resp.pending) continue;
    if (resp.error) throw new Error(resp.error === 'denied' ? 'Sign-in was cancelled.' : 'Sign-in failed (' + resp.error + ').');
    if (resp.ok && resp.access_token) {
      const state = {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token || null,
        expires_at: resp.expires_at || null,
        scope: resp.scope || '',
        identity: resp.identity || null,
      };
      writeState(platform, role, state);
      const pub = publicStatus(state);
      emitStatus(platform, role, pub);
      return pub;
    }
  }
  throw new Error('Sign-in timed out. Try again.');
}

function getStatus(platform, role) { return publicStatus(readState(platform, role === 'bot' ? 'bot' : 'broadcaster')); }
function signOut(platform, role) {
  role = role === 'bot' ? 'bot' : 'broadcaster';
  clearState(platform, role);
  const pub = publicStatus(null);
  emitStatus(platform, role, pub);
  return pub;
}
// For features that act with the token directly (chat send, etc.).
function getRawAccessToken(platform, role) {
  const s = readState(platform, role === 'bot' ? 'bot' : 'broadcaster');
  return s && s.access_token ? s.access_token : null;
}

function registerIpcHandlers() {
  ipcMain.handle('platform-begin-auth', function (e, a) { a = a || {}; return beginAuth(a.platform, a.role); });
  ipcMain.handle('platform-get-status', function (e, a) { a = a || {}; return getStatus(a.platform, a.role); });
  ipcMain.handle('platform-sign-out',  function (e, a) { a = a || {}; return signOut(a.platform, a.role); });
}

module.exports = { registerIpcHandlers, setMainWindow, beginAuth, getStatus, signOut, getRawAccessToken };
