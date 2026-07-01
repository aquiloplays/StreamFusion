// Cloudflare Worker for StreamFusion + aquilo.gg — auth broker.
// (Patreon support removed 2026-06-30 — Twitch is the sole identity now;
//  any unmatched path returns 404.)
//
//   2. /community-recap
//      Receives stream-recap POSTs from EA supporters who opted into
//      sharing their recap to the aquilo.gg community Discord. Adds the
//      community webhook URL from the Worker's encrypted secret store
//      and forwards to Discord. The app never sees the URL, so scrapers
//      can't flood the channel by pulling it out of a public repo.
//
//   3. /beta-info
//      Returns JSON about the latest StreamFusion Beta pre-release on
//      aquiloplays/StreamFusion-beta (a private repo). Used by the
//      Tier-3-only access HTML (hosted on Patreon) to display the
//      current version + release date without hardcoding. CORS-open
//      so the HTML can fetch this from file:// or any origin.
//
//   4. /beta-download/latest/:alias
//      Redirects (302) to a short-lived signed GitHub asset URL for the
//      latest StreamFusion Beta pre-release. Aliases:
//        setup    → StreamFusion-Beta-Setup-*.exe
//        portable → StreamFusion-Beta-Portable-*.exe
//        manifest → beta.yml
//      The Worker authenticates to GitHub with GITHUB_BETA_TOKEN and
//      follows the asset's `Accept: application/octet-stream` redirect
//      so the client downloads directly from S3, not through the Worker.
//      Gating is done on the Patreon side (only Tier 3 members see the
//      HTML that knows these URLs); the endpoints themselves are
//      security-through-obscurity rather than authenticated. If abuse
//      shows up in logs, swap in a Patreon-token check.
//
//   5. /discord-token
//      Discord OAuth token exchange proxy — same pattern as the Patreon
//      proxy, but for the StreamFusion Discord OAuth application. Lets
//      supporters Connect Discord inside SF as a second path to EA
//      entitlement (see discord-auth.js in the app). Holds the Discord
//      client_secret server-side. Accepts POSTs with grant_type of
//      authorization_code or refresh_token. Redirect URIs restricted
//      to 127.0.0.1 for the loopback-auth pattern.
//
//   6. /beta-updater-token
//      Vends GITHUB_BETA_TOKEN to verified current Tier 3 patrons (or
//      the owner) so beta installs auto-update without the user having
//      to manage a PAT file by hand at userData/beta-updater-token.txt.
//      The Worker verifies entitlement server-side against Patreon's
//      identity API, using the Patreon access token the SF app already
//      holds. The PAT itself stays secret to the Worker; clients only
//      get it back when they prove they are entitled NOW. SF caches the
//      returned PAT to disk and falls back to the cache when the Worker
//      is unreachable; on an explicit 403 the cache is wiped so demoted
//      patrons lose beta-update access on next launch.
//
// Deploy:
//   1. wrangler init or create a Worker in the Cloudflare dashboard
//   2. Paste this file as the Worker script
//   3. Set secrets (wrangler secret put OR dashboard → Variables):
//        PATREON_CLIENT_ID
//        PATREON_CLIENT_SECRET
//        COMMUNITY_RECAP_WEBHOOK     ← Discord webhook URL for #stream-recaps
//        GITHUB_BETA_TOKEN           ← Fine-grained PAT with Contents: Read on
//                                      aquiloplays/StreamFusion-beta (only)
//        DISCORD_CLIENT_ID           ← StreamFusion Discord app client ID
//                                      (same as the bot's application ID)
//        DISCORD_CLIENT_SECRET       ← StreamFusion Discord app client secret
//                                      (from discord.com/developers → OAuth2)
//      Optional plaintext vars:
//        ALLOWED_REDIRECT_HOSTS = "127.0.0.1"
//        BETA_REPO_OWNER = "aquiloplays"          (default)
//        BETA_REPO_NAME  = "StreamFusion-beta"    (default)
//   4. Bind route auth.aquilo.gg/* to this Worker (optional)
//
// Security posture:
//   - Each endpoint has narrow, method-specific validation
//   - Webhook URL is never returned to clients; only embed forwarded
//   - /beta-download never returns the PAT; only a signed S3 redirect
//   - CORS is open on /beta-info + /beta-download (the HTML may be
//     opened from a file:// context via Patreon download-to-disk)
//   - Patreon token proxy + community recap remain CORS-closed

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/community-recap') {
      return handleCommunityRecap(request, env);
    }
    if (path === '/beta-info') {
      return handleBetaInfo(request, env);
    }
    if (path.indexOf('/beta-download/') === 0) {
      return handleBetaDownload(request, env, path);
    }
    if (path === '/discord-token') {
      return handleDiscordTokenProxy(request, env);
    }
    // Twitch — OAuth broker for the docks + loopback token exchange for the app.
    if (path === '/twitch/login')    return handleTwitchLogin(request, env);
    if (path === '/twitch/callback') return handleTwitchCallback(request, env);
    if (path === '/twitch/me')       return handleTwitchMe(request, env);
    if (path === '/twitch/api')      return handleTwitchApi(request, env);
    if (path === '/twitch/logout')   return handleTwitchLogout(request, env);
    if (path === '/twitch-token')    return handleTwitchTokenProxy(request, env);
    // Unified "Aquilo ID" — one broadcaster/bot authorization stored in the
    // shared vault, reusable by every product.
    if (path === '/twitch/connect')     return handleTwitchConnect(request, env);
    if (path === '/twitch/vault/token') return handleVaultToken(request, env);
    return json({ error: 'not_found' }, 404);
  }
};

// ── Discord OAuth token exchange proxy ─────────────────────────────────────
// Mirrors handlePatreonTokenProxy for the StreamFusion Discord OAuth
// application. Injects DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET server-
// side so the app binary never ships the secret. Same 127.0.0.1 redirect
// allowlist as the Patreon proxy.
async function handleDiscordTokenProxy(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }
  var body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'invalid_json' }, 400); }

  var grant = body && body.grant_type;
  if (grant !== 'authorization_code' && grant !== 'refresh_token') {
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return json({ error: 'discord_proxy_not_configured' }, 500);
  }

  var form = new URLSearchParams();
  form.set('grant_type', grant);
  form.set('client_id', env.DISCORD_CLIENT_ID);
  form.set('client_secret', env.DISCORD_CLIENT_SECRET);

  if (grant === 'authorization_code') {
    if (!body.code || !body.redirect_uri) return json({ error: 'missing_code_or_redirect' }, 400);
    // Discord rejects bare-IP redirects like 127.0.0.1 — the app uses
    // `localhost` for Discord OAuth. Accept both by default so Patreon
    // (which registered 127.0.0.1) and Discord (localhost) both work.
    var allowed = (env.ALLOWED_REDIRECT_HOSTS || '127.0.0.1,localhost').split(',').map(function(s) { return s.trim(); });
    var u;
    try { u = new URL(body.redirect_uri); } catch (e) { return json({ error: 'invalid_redirect_uri' }, 400); }
    if (allowed.indexOf(u.hostname) === -1) return json({ error: 'redirect_host_not_allowed' }, 400);
    form.set('code', body.code);
    form.set('redirect_uri', body.redirect_uri);
  } else {
    if (!body.refresh_token) return json({ error: 'missing_refresh_token' }, 400);
    form.set('refresh_token', body.refresh_token);
  }

  var discordResp;
  try {
    discordResp = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'StreamFusion-EA-Proxy'
      },
      body: form.toString()
    });
  } catch (e) { return json({ error: 'upstream_unreachable', detail: String(e) }, 502); }

  var text = await discordResp.text();
  return new Response(text, {
    status: discordResp.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── Community recap forwarding ─────────────────────────────────────────────
//
// Accepts a POST with { embed, streamerName, streamerChannel } from an EA
// supporter whose StreamFusion is configured to share recaps to aquilo.gg.
// We lightly annotate the incoming embed with "Shared from @{streamerName}"
// in the author field so the community channel tells viewers WHOSE recap
// they're looking at, then forward to Discord. The webhook URL stays on
// the Worker — a scraper pulling StreamFusion's public repo never sees it.
// The /community-recap endpoint is unauthenticated (the SF renderer can't
// hold a Patreon token to sign with), so rebuild the embed from a strict
// whitelist before forwarding. An anonymous caller can then at most post a
// constrained, attribution-stamped recap card, never arbitrary Discord
// content, pings, or non-https media.
function _httpsUrl(u) {
  try { var x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : undefined; }
  catch (e) { return undefined; }
}
function _sanitizeRecapEmbed(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var out = {};
  if (raw.title) out.title = String(raw.title).slice(0, 256);
  if (raw.description) out.description = String(raw.description).slice(0, 2048);
  if (raw.url) out.url = _httpsUrl(raw.url);
  if (typeof raw.color === 'number' && isFinite(raw.color)) out.color = raw.color & 0xffffff;
  if (raw.timestamp) { var t = new Date(raw.timestamp); if (!isNaN(t.getTime())) out.timestamp = t.toISOString(); }
  if (raw.thumbnail && raw.thumbnail.url) { var tu = _httpsUrl(raw.thumbnail.url); if (tu) out.thumbnail = { url: tu }; }
  if (raw.image && raw.image.url) { var iu = _httpsUrl(raw.image.url); if (iu) out.image = { url: iu }; }
  if (Array.isArray(raw.fields)) {
    out.fields = raw.fields.slice(0, 25).map(function(f) {
      return (f && f.name != null) ? {
        name: String(f.name).slice(0, 256),
        value: String(f.value == null ? '' : f.value).slice(0, 1024),
        inline: !!f.inline
      } : null;
    }).filter(Boolean);
  }
  return out;
}
async function handleCommunityRecap(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }
  if (!env.COMMUNITY_RECAP_WEBHOOK) {
    return json({ error: 'community_webhook_not_configured' }, 500);
  }

  var body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'invalid_json' }, 400); }

  // Rebuild the embed from a strict whitelist (we expect { embed, streamerName? }).
  var srcEmbed = _sanitizeRecapEmbed(body && body.embed);
  if (!srcEmbed) {
    return json({ error: 'missing_embed' }, 400);
  }

  // Stamp the embed with a "shared by X" author block so community viewers
  // see attribution. Overwrites any author already on the embed so nobody
  // can spoof "Shared from @aquilo_plays".
  var streamerName = (body.streamerName || 'a StreamFusion supporter').toString().slice(0, 64);
  var streamerChannel = (body.streamerChannel || '').toString().slice(0, 128);
  srcEmbed.author = {
    name: 'Shared by ' + streamerName,
    url: streamerChannel || undefined
  };
  // Nudge the footer so the community channel is clearly branded even if
  // the incoming embed had its own footer.
  srcEmbed.footer = { text: 'Community recap \u00b7 Powered by StreamFusion \u26a1 aquilo.gg' };

  // Rate-limit mitigation: very simple per-Worker in-memory counter for
  // streamer names would drop extra posts within a short window. Cloudflare
  // Workers are per-isolate so this is best-effort; real enforcement would
  // need Durable Objects or KV. For EA scale (handful of supporters) this
  // is overkill — Discord's own webhook rate limiting (30 req / 60s per
  // webhook) is the functional ceiling.

  var discordResp;
  try {
    discordResp = await fetch(env.COMMUNITY_RECAP_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [srcEmbed] })
    });
  } catch (e) { return json({ error: 'upstream_unreachable', detail: String(e) }, 502); }

  if (!discordResp.ok) {
    var txt = await discordResp.text();
    return json({ error: 'discord_post_failed', status: discordResp.status, detail: txt.slice(0, 200) }, 502);
  }
  return json({ ok: true });
}

// ── Beta release info (Tier 3 HTML reads this for dynamic version) ─────────
// Returns JSON for the latest non-draft release (prefers prereleases, since
// this worker fronts the BETA repo). Shape mirrors what the HTML renders:
//   { version, name, tag, publishedAt, assets: [{ name, size }] }
// The raw asset download URL is NOT included — those live under
// /beta-download/latest/* so the PAT never leaves the worker.
async function handleBetaInfo(request, env) {
  if (request.method === 'OPTIONS') return preflightCors();
  if (request.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, corsHeaders());
  }
  if (!env.GITHUB_BETA_TOKEN) {
    return json({ error: 'beta_proxy_not_configured' }, 500, corsHeaders());
  }
  var rel = await _fetchLatestBetaRelease(env);
  if (!rel) return json({ error: 'no_releases' }, 404, corsHeaders());
  var assets = (rel.assets || []).map(function(a) {
    return { name: a.name, size: a.size };
  });
  return json({
    version:     (rel.tag_name || '').replace(/^v/, ''),
    tag:         rel.tag_name || '',
    name:        rel.name || '',
    prerelease:  !!rel.prerelease,
    publishedAt: rel.published_at || null,
    htmlUrl:     rel.html_url || null,
    body:        rel.body || '',
    assets:      assets
  }, 200, corsHeaders());
}

// ── Beta release download (302 to signed S3 URL) ───────────────────────────
// Path shapes accepted:
//   /beta-download/latest/setup        → StreamFusion-Beta-Setup-*.exe
//   /beta-download/latest/portable     → StreamFusion-Beta-Portable-*.exe
//   /beta-download/latest/manifest     → beta.yml
// The alias is matched case-insensitively against a regex over the asset
// name. The client follows our 302 to a short-lived (≈5 min) signed GitHub
// S3 URL that serves the actual bytes directly — no data flows through
// the Worker, so bandwidth + CPU stay near zero.
async function handleBetaDownload(request, env, path) {
  if (request.method === 'OPTIONS') return preflightCors();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, corsHeaders());
  }
  if (!env.GITHUB_BETA_TOKEN) {
    return json({ error: 'beta_proxy_not_configured' }, 500, corsHeaders());
  }

  // Parse `/beta-download/latest/<alias>`. Only `latest` is supported for
  // now — can add `/beta-download/:tag/<alias>` later if a specific beta
  // tag needs to be pinnable from the HTML.
  var parts = path.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'beta-download' || parts[1] !== 'latest') {
    return json({ error: 'not_found' }, 404, corsHeaders());
  }
  var alias = parts[2].toLowerCase();
  var matcher;
  if (alias === 'setup')         matcher = /^StreamFusion-Beta-Setup-.*\.exe$/i;
  else if (alias === 'portable') matcher = /^StreamFusion-Beta-Portable-.*\.exe$/i;
  else if (alias === 'manifest') matcher = /^beta\.yml$/i;
  else return json({ error: 'unknown_alias', alias: alias }, 400, corsHeaders());

  var rel = await _fetchLatestBetaRelease(env);
  if (!rel) return json({ error: 'no_releases' }, 404, corsHeaders());
  var asset = (rel.assets || []).find(function(a) { return matcher.test(a.name); });
  if (!asset) return json({ error: 'asset_not_found', alias: alias }, 404, corsHeaders());

  // HEAD short-circuit so link-checkers / Discord embed previews don't
  // consume a GitHub asset-redirect (which is rate-limited per hour).
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: Object.assign({ 'Content-Length': String(asset.size) }, corsHeaders()) });
  }

  // Ask GitHub for the signed URL. `asset.url` + Accept: octet-stream
  // returns a 302 with the pre-signed S3 URL in Location. `redirect:
  // 'manual'` stops Workers' fetch from auto-following — we need to
  // re-emit that Location to the client.
  var resp;
  try {
    resp = await fetch(asset.url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Authorization': 'token ' + env.GITHUB_BETA_TOKEN,
        'User-Agent':    'StreamFusion-Beta-Proxy',
        'Accept':        'application/octet-stream'
      }
    });
  } catch (e) {
    return json({ error: 'github_unreachable', detail: String(e) }, 502, corsHeaders());
  }

  var signedUrl = resp.headers.get('Location');
  if (resp.status !== 302 || !signedUrl) {
    // Fall through to text body for easier diagnosis.
    var txt = '';
    try { txt = (await resp.text()).slice(0, 200); } catch (e) {}
    return json({ error: 'github_no_redirect', status: resp.status, detail: txt }, 502, corsHeaders());
  }

  return new Response(null, {
    status: 302,
    headers: Object.assign({
      'Location':      signedUrl,
      'Cache-Control': 'no-store'
    }, corsHeaders())
  });
}

// Fetch the "latest" release on the beta repo. Prefers the most recent
// non-draft release — which for this repo means the most recent
// pre-release, since we only publish pre-releases here. Skips drafts.
// `per_page=5` because we don't ever expect more than a handful of live
// releases and we want to pick among them cheaply.
async function _fetchLatestBetaRelease(env) {
  var owner = env.BETA_REPO_OWNER || 'aquiloplays';
  var repo  = env.BETA_REPO_NAME  || 'StreamFusion-beta';
  var url = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases?per_page=5';
  var resp;
  try {
    resp = await fetch(url, {
      headers: {
        'Authorization': 'token ' + env.GITHUB_BETA_TOKEN,
        'User-Agent':    'StreamFusion-Beta-Proxy',
        'Accept':        'application/vnd.github.v3+json'
      }
    });
  } catch (e) { return null; }
  if (!resp.ok) return null;
  var list;
  try { list = await resp.json(); } catch (e) { return null; }
  if (!Array.isArray(list)) return null;
  // Newest first (GitHub default). Filter drafts. Keep prereleases.
  for (var i = 0; i < list.length; i++) {
    if (!list[i].draft) return list[i];
  }
  return null;
}

// CORS helpers. Open on the beta endpoints so the HTML (possibly served
// from file:// when a Tier-3 patron downloaded it from Patreon as a
// standalone .html) can fetch and follow links without origin checks.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function preflightCors() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function json(obj, status, extraHeaders) {
  var headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: headers
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Twitch — OAuth broker + Helix proxy
// ════════════════════════════════════════════════════════════════════════════
//
// One Twitch app (the broadcaster's own, registered at dev.twitch.tv/console),
// two kinds of consumer:
//
//   • StreamFusion desktop (Electron) does the OAuth dance itself with an
//     http://localhost loopback redirect (same shape as Patreon/Discord) and
//     POSTs the code to /twitch-token for the secret-side exchange. The app
//     holds the tokens (safeStorage) and calls Helix directly, refreshing via
//     /twitch-token grant_type=refresh_token.
//
//   • Browser docks (Raid Finder, StreamFusion OBS) can't run a loopback
//     server, so the Worker brokers everything and the access token NEVER
//     reaches the browser:
//        GET  /twitch/login?state=<sessionId>&return=<dockUrl>
//             → 302 to Twitch authorize (redirect_uri = /twitch/callback)
//        GET  /twitch/callback?code=&state=
//             → exchanges the code, stores tokens in KV under the session id,
//               302s back to the dock with #twitch=ok
//        GET  /twitch/me?session=<id>      → { authed, login, user_id, scope }
//        POST /twitch/api  { session, method, path, query, body }
//             → session-keyed Helix proxy (the session id is the bearer; the
//               real token + refresh stay in KV and are refreshed server-side)
//        GET  /twitch/logout?session=<id>  → forget the session
//
// Owner setup (once):
//   1. dev.twitch.tv/console → Register Your Application
//        Name: StreamFusion / Aquilo   Category: Broadcasting Suite
//        Client Type: Confidential
//        OAuth Redirect URLs:
//          https://auth.aquilo.gg/twitch/callback     (docks)
//          http://localhost:17829/callback            (desktop app)
//   2. wrangler.toml [vars] → TWITCH_CLIENT_ID = "<your client id>"
//   3. wrangler secret put TWITCH_CLIENT_SECRET        (never in the repo)
//   4. wrangler kv namespace create TWITCH_SESSIONS    → bind in wrangler.toml
//
const TWITCH_OAUTH = 'https://id.twitch.tv/oauth2';
const TWITCH_HELIX = 'https://api.twitch.tv/helix';
const TWITCH_CALLBACK_DEFAULT = 'https://auth.aquilo.gg/twitch/callback';
// Scopes the docks + app need: start/cancel raids, mod timeout/ban + delete
// message, create clips, and read the user's identity. Override via env if a
// surface ever needs more (e.g. channel:read:subscriptions).
const TWITCH_SCOPES = [
  'channel:manage:raids',
  'moderator:manage:banned_users',
  'moderator:manage:chat_messages',
  'clips:edit',
  'user:read:email'
].join(' ');
// Unified "Connect Aquilo to your channel" — the union of scopes every Aquilo
// product needs (bot chat, subs/bits/points, EventSub reads, moderation, raids/
// clips/broadcast control). The streamer grants once; every tool reuses it.
const BROADCASTER_CONNECT_SCOPES = [
  'user:read:email',
  'user:read:chat', 'user:write:chat', 'user:bot', 'channel:bot',
  'channel:read:subscriptions', 'bits:read',
  'channel:read:redemptions', 'channel:manage:redemptions',
  'moderator:read:followers', 'channel:read:hype_train',
  'channel:read:polls', 'channel:manage:polls',
  'channel:read:predictions', 'channel:manage:predictions',
  'channel:read:charity', 'channel:read:ads', 'channel:moderate',
  'moderator:manage:banned_users', 'moderator:manage:chat_messages',
  'moderator:manage:announcements', 'moderator:read:shoutouts',
  'moderator:read:suspicious_users',
  'channel:manage:raids', 'clips:edit',
  'channel:manage:broadcast', 'channel:manage:ads', 'channel:edit:commercial'
].join(' ');
// A separate bot account only needs to read + post chat as itself.
const BOT_CONNECT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'].join(' ');
function VAULT_KEY(twitchId) { return 'vault:tw:' + twitchId; }

// Helix path prefixes the session proxy will forward. Keeps a leaked session
// id from being a skeleton key to the whole API.
const TWITCH_HELIX_ALLOW = [
  'users', 'streams', 'channels', 'search/channels', 'games',
  'raids', 'moderation/bans', 'moderation/chat', 'clips'
];

// The docks call /twitch/me + /twitch/api cross-origin (aquilo.gg →
// auth.aquilo.gg), so those need CORS. The session id is the bearer and lives
// only in the dock's own localStorage, so echoing the dock origin is safe.
function twitchCors(request) {
  var origin = request.headers.get('Origin') || '';
  var ok = false;
  try {
    var u = new URL(origin);
    ok = (u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
          u.origin === 'https://aquilo.gg' || u.origin === 'https://widget.aquilo.gg');
  } catch (e) { ok = false; }
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://aquilo.gg',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

// Only let the dock bounce the browser back to a trusted origin.
function _twitchReturnAllowed(ret) {
  try {
    var u = new URL(ret);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return (u.origin === 'https://aquilo.gg' || u.origin === 'https://widget.aquilo.gg');
  } catch (e) { return false; }
}

function _b64urlEncode(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}
// Put our status on the fragment so it never lands in a server log.
function _appendHash(urlStr, hash) {
  return urlStr + (urlStr.indexOf('#') === -1 ? '#' : '&') + hash;
}

// id.twitch.tv token exchange (authorization_code or refresh_token), with the
// client_id + secret injected here so neither ever ships in a dock or binary.
async function _twitchExchange(env, params) {
  var form = new URLSearchParams();
  form.set('client_id', env.TWITCH_CLIENT_ID);
  form.set('client_secret', env.TWITCH_CLIENT_SECRET);
  Object.keys(params).forEach(function (k) { form.set(k, params[k]); });
  var resp;
  try {
    resp = await fetch(TWITCH_OAUTH + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
  } catch (e) { return null; }
  if (!resp.ok) return null;
  try { return await resp.json(); } catch (e) { return null; }
}

// Load a dock session from KV, transparently refreshing the access token when
// it's within 2 minutes of expiry.
async function _twitchSession(env, session) {
  if (!session || !env.TWITCH_SESSIONS) return null;
  var raw = await env.TWITCH_SESSIONS.get('tw:' + session);
  if (!raw) return null;
  var rec; try { rec = JSON.parse(raw); } catch (e) { return null; }
  if (rec.expires_at && (rec.expires_at - Date.now() < 120000) && rec.refresh_token) {
    var t = await _twitchExchange(env, { grant_type: 'refresh_token', refresh_token: rec.refresh_token });
    if (t && t.access_token) {
      rec.access_token = t.access_token;
      if (t.refresh_token) rec.refresh_token = t.refresh_token;
      rec.expires_at = Date.now() + ((t.expires_in || 3600) * 1000);
      rec.scope = Array.isArray(t.scope) ? t.scope.join(' ') : (t.scope || rec.scope);
      await env.TWITCH_SESSIONS.put('tw:' + session, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 60 });
    }
  }
  return rec;
}

// One Helix call with the broadcaster's token + the app Client-Id.
async function _twitchHelix(env, accessToken, method, path, query, body) {
  var u = TWITCH_HELIX + '/' + path + (query ? ('?' + query) : '');
  var init = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Client-Id': env.TWITCH_CLIENT_ID,
      'Content-Type': 'application/json'
    }
  };
  if (body != null && method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
  var resp = await fetch(u, init);
  var text = await resp.text();
  var data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  return { status: resp.status, data: data };
}

// GET /twitch/login?state=<sessionId>&return=<dockUrl> → 302 to Twitch.
async function handleTwitchLogin(request, env) {
  if (!env.TWITCH_CLIENT_ID) return json({ error: 'twitch_not_configured' }, 500);
  var url = new URL(request.url);
  var session = url.searchParams.get('state') || url.searchParams.get('session') || '';
  var ret = url.searchParams.get('return') || url.searchParams.get('redirect') || '';
  if (!session || session.length < 16) return json({ error: 'missing_or_short_session' }, 400);
  if (!ret || !_twitchReturnAllowed(ret)) return json({ error: 'return_not_allowed' }, 400);
  var redirectUri = env.TWITCH_REDIRECT_URI || TWITCH_CALLBACK_DEFAULT;
  // Scope mode: viewers signing in on aquilo.gg only need their identity, so
  // they get a friendly identity-only consent screen instead of being asked to
  // grant raid/mod/clip powers. The broadcaster docks omit ?scope and get the
  // full TWITCH_SCOPES set. ?scope=identity (or =viewer) → user:read:email only.
  var scopeMode = (url.searchParams.get('scope') || '').toLowerCase();
  var scopes = (scopeMode === 'identity' || scopeMode === 'viewer')
    ? 'user:read:email'
    : (env.TWITCH_SCOPES || TWITCH_SCOPES);
  var state = _b64urlEncode(JSON.stringify({ s: session, r: ret }));
  var authUrl = TWITCH_OAUTH + '/authorize'
    + '?client_id=' + encodeURIComponent(env.TWITCH_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scopes)
    + '&state=' + encodeURIComponent(state);
  return new Response(null, { status: 302, headers: { 'Location': authUrl, 'Cache-Control': 'no-store' } });
}

// GET /twitch/callback?code=&state= → exchange, store in KV, 302 back to dock.
async function handleTwitchCallback(request, env) {
  var url = new URL(request.url);
  var err = url.searchParams.get('error');
  var code = url.searchParams.get('code');
  var state; try { state = JSON.parse(_b64urlDecode(url.searchParams.get('state') || '')); } catch (e) { state = null; }
  var ret = (state && state.r) || '';
  var session = (state && state.s) || '';
  if (!ret || !_twitchReturnAllowed(ret) || !session) return json({ error: 'bad_state' }, 400);
  if (err || !code) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'twitch=error') } });
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || !env.TWITCH_SESSIONS) {
    return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'twitch=error&reason=not_configured') } });
  }
  var redirectUri = env.TWITCH_REDIRECT_URI || TWITCH_CALLBACK_DEFAULT;
  var tok = await _twitchExchange(env, { grant_type: 'authorization_code', code: code, redirect_uri: redirectUri });
  if (!tok || !tok.access_token) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'twitch=error&reason=exchange') } });
  var meRes = await _twitchHelix(env, tok.access_token, 'GET', 'users', '', null);
  var u = meRes && meRes.data && meRes.data.data && meRes.data.data[0];
  var rec = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || '',
    expires_at: Date.now() + ((tok.expires_in || 3600) * 1000),
    scope: Array.isArray(tok.scope) ? tok.scope.join(' ') : (tok.scope || ''),
    login: u ? u.login : '',
    user_id: u ? u.id : '',
    display_name: u ? u.display_name : ''
  };
  // Unified "Connect" (broadcaster/bot authorization) → persist to the shared
  // vault keyed by Twitch id, so every product can act for this streamer. The
  // dock/identity flows (no state.m) keep the existing session-KV behavior.
  var mode = state && state.m;
  if (mode === 'connect' || mode === 'bot') {
    if (!env.LOADOUT_BOLTS || !u) {
      return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=not_configured') } });
    }
    var ownerId = mode === 'bot' ? String((state && state.o) || '') : u.id;
    if (!ownerId) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=no_owner') } });
    var vkey = VAULT_KEY(ownerId);
    var vraw = await env.LOADOUT_BOLTS.get(vkey);
    var vault; try { vault = vraw ? JSON.parse(vraw) : {}; } catch (e) { vault = {}; }
    var sub = {
      twitchId: u.id, login: u.login, display_name: u.display_name,
      refresh_token: tok.refresh_token || '', access_token: tok.access_token,
      expires_at: rec.expires_at, scope: rec.scope, updatedAt: Date.now()
    };
    if (mode === 'bot') {
      vault.bot = sub;
    } else {
      vault.twitchId = u.id; vault.login = u.login; vault.display_name = u.display_name;
      vault.broadcaster = sub;
      if (!vault.connectedAt) vault.connectedAt = Date.now();
    }
    vault.updatedAt = Date.now();
    await env.LOADOUT_BOLTS.put(vkey, JSON.stringify(vault));
    return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=' + (mode === 'bot' ? 'bot' : 'ok')), 'Cache-Control': 'no-store' } });
  }

  await env.TWITCH_SESSIONS.put('tw:' + session, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 60 });
  return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'twitch=ok'), 'Cache-Control': 'no-store' } });
}

// GET /twitch/me?session=<id> → auth status + the dock's own broadcaster id.
async function handleTwitchMe(request, env) {
  var cors = twitchCors(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  var url = new URL(request.url);
  var rec = await _twitchSession(env, url.searchParams.get('session') || '');
  if (!rec || !rec.access_token) return json({ authed: false }, 200, cors);
  return json({ authed: true, login: rec.login, user_id: rec.user_id, display_name: rec.display_name, scope: rec.scope }, 200, cors);
}

// POST /twitch/api { session, method, path, query, body } → Helix proxy.
async function handleTwitchApi(request, env) {
  var cors = twitchCors(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
  var body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400, cors); }
  var session = body && body.session;
  var method = ((body && body.method) || 'GET').toUpperCase();
  var clean = String((body && body.path) || '').replace(/^\/+/, '').replace(/\/+$/, '');
  var query = (body && body.query) || '';
  var payload = (body && body.body) || null;
  var allowed = TWITCH_HELIX_ALLOW.some(function (p) { return clean === p || clean.indexOf(p + '/') === 0; });
  if (!allowed) return json({ error: 'path_not_allowed', path: clean }, 403, cors);
  if (['GET', 'POST', 'DELETE', 'PATCH', 'PUT'].indexOf(method) === -1) return json({ error: 'bad_method' }, 400, cors);
  var rec = await _twitchSession(env, session);
  if (!rec || !rec.access_token) return json({ error: 'not_authed' }, 401, cors);
  var res;
  try { res = await _twitchHelix(env, rec.access_token, method, clean, query, payload); }
  catch (e) { return json({ error: 'helix_unreachable', detail: String(e) }, 502, cors); }
  return json({ status: res.status, data: res.data, broadcaster_id: rec.user_id, login: rec.login }, 200, cors);
}

// GET /twitch/logout?session=<id> → drop the KV session.
async function handleTwitchLogout(request, env) {
  var cors = twitchCors(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  var url = new URL(request.url);
  var session = url.searchParams.get('session') || '';
  if (session && env.TWITCH_SESSIONS) await env.TWITCH_SESSIONS.delete('tw:' + session);
  return json({ ok: true }, 200, cors);
}

// POST /twitch-token — desktop loopback exchange, same shape as /discord-token.
// The app runs the OAuth dance with an http://localhost redirect and POSTs the
// code here; the app holds the returned tokens itself.
async function handleTwitchTokenProxy(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  var body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
  var grant = body && body.grant_type;
  if (grant !== 'authorization_code' && grant !== 'refresh_token') return json({ error: 'unsupported_grant_type' }, 400);
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return json({ error: 'twitch_not_configured' }, 500);
  var params = { grant_type: grant };
  if (grant === 'authorization_code') {
    if (!body.code || !body.redirect_uri) return json({ error: 'missing_code_or_redirect' }, 400);
    var allowed = (env.ALLOWED_REDIRECT_HOSTS || '127.0.0.1,localhost').split(',').map(function (s) { return s.trim(); });
    var ru; try { ru = new URL(body.redirect_uri); } catch (e) { return json({ error: 'invalid_redirect_uri' }, 400); }
    if (allowed.indexOf(ru.hostname) === -1) return json({ error: 'redirect_host_not_allowed' }, 400);
    params.code = body.code;
    params.redirect_uri = body.redirect_uri;
  } else {
    if (!body.refresh_token) return json({ error: 'missing_refresh_token' }, 400);
    params.refresh_token = body.refresh_token;
  }
  var t = await _twitchExchange(env, params);
  if (!t) return json({ error: 'upstream_unreachable' }, 502);
  return json(t, 200);
}

// GET /twitch/connect?state=<nonce>&return=<origin>&mode=broadcaster|bot&owner=<id>
// The unified "Connect Aquilo to your channel" (and optional bot account). Same
// authorize dance as /twitch/login but with the full BROADCASTER/BOT scope set,
// force_verify so the streamer can pick the account, and state.m tagged so the
// shared callback persists to the vault instead of a dock session. `owner` (the
// broadcaster's Twitch id) is required for bot mode and is set server-side by
// the aquilo.gg /api/connect/start endpoint from the signed-in session.
async function handleTwitchConnect(request, env) {
  if (!env.TWITCH_CLIENT_ID) return json({ error: 'twitch_not_configured' }, 500);
  var url = new URL(request.url);
  var session = url.searchParams.get('state') || url.searchParams.get('session') || '';
  var ret = url.searchParams.get('return') || url.searchParams.get('redirect') || '';
  var mode = (url.searchParams.get('mode') || 'broadcaster').toLowerCase();
  var owner = url.searchParams.get('owner') || '';
  if (!session || session.length < 16) return json({ error: 'missing_or_short_session' }, 400);
  if (!ret || !_twitchReturnAllowed(ret)) return json({ error: 'return_not_allowed' }, 400);
  var isBot = mode === 'bot';
  if (isBot && !owner) return json({ error: 'bot_mode_requires_owner' }, 400);
  var scopes = isBot ? BOT_CONNECT_SCOPES : BROADCASTER_CONNECT_SCOPES;
  var redirectUri = env.TWITCH_REDIRECT_URI || TWITCH_CALLBACK_DEFAULT;
  var state = _b64urlEncode(JSON.stringify({ s: session, r: ret, m: isBot ? 'bot' : 'connect', o: owner }));
  var authUrl = TWITCH_OAUTH + '/authorize'
    + '?client_id=' + encodeURIComponent(env.TWITCH_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scopes)
    + '&force_verify=true'
    + '&state=' + encodeURIComponent(state);
  return new Response(null, { status: 302, headers: { 'Location': authUrl, 'Cache-Control': 'no-store' } });
}

// POST /twitch/vault/token { service, twitchId, role:'broadcaster'|'bot' }
// Service-secret-guarded. Returns a FRESH broadcaster/bot access token for a
// connected streamer (auto-refreshing via the stored refresh token). This is
// how cross-namespace products (rotation-bot, etc.) act as the streamer without
// running their own OAuth. Same-account consumers can read vault:tw:<id> from
// LOADOUT_BOLTS directly, but still call this to get a refreshed access token.
async function handleVaultToken(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  var body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
  if (!env.VAULT_SERVICE_SECRET || !body || body.service !== env.VAULT_SERVICE_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.LOADOUT_BOLTS) return json({ error: 'vault_not_configured' }, 500);
  var twitchId = String(body.twitchId || '');
  var role = body.role === 'bot' ? 'bot' : 'broadcaster';
  if (!twitchId) return json({ error: 'missing_twitchId' }, 400);
  var vraw = await env.LOADOUT_BOLTS.get(VAULT_KEY(twitchId));
  if (!vraw) return json({ error: 'not_connected' }, 404);
  var vault; try { vault = JSON.parse(vraw); } catch (e) { return json({ error: 'corrupt' }, 500); }
  var sub = role === 'bot' ? vault.bot : vault.broadcaster;
  if (!sub || !sub.refresh_token) return json({ error: 'role_not_connected', role: role }, 404);
  if (!sub.access_token || !sub.expires_at || (sub.expires_at - Date.now() < 120000)) {
    var t = await _twitchExchange(env, { grant_type: 'refresh_token', refresh_token: sub.refresh_token });
    if (!t || !t.access_token) return json({ error: 'refresh_failed' }, 502);
    sub.access_token = t.access_token;
    if (t.refresh_token) sub.refresh_token = t.refresh_token;
    sub.expires_at = Date.now() + ((t.expires_in || 3600) * 1000);
    sub.scope = Array.isArray(t.scope) ? t.scope.join(' ') : (t.scope || sub.scope);
    sub.updatedAt = Date.now();
    if (role === 'bot') vault.bot = sub; else vault.broadcaster = sub;
    await env.LOADOUT_BOLTS.put(VAULT_KEY(twitchId), JSON.stringify(vault));
  }
  return json({ ok: true, access_token: sub.access_token, expires_at: sub.expires_at, scope: sub.scope, login: sub.login, client_id: env.TWITCH_CLIENT_ID }, 200);
}
