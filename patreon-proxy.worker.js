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
    // Kick + YouTube channel/bot connect + vault (mirror the Twitch flow,
    // parameterized by PLATFORM_CFG). Dark until the platform's client id is set.
    if (path === '/kick/connect')        return handlePlatformConnect(request, env, PLATFORM_CFG.kick);
    if (path === '/kick/callback')       return handlePlatformCallback(request, env, PLATFORM_CFG.kick);
    if (path === '/kick/vault/token')    return handlePlatformVaultToken(request, env, PLATFORM_CFG.kick);
    if (path === '/kick/reward/ensure')  return handleKickRewardEnsure(request, env);
    if (path === '/kick/reward/delete')  return handleKickRewardDelete(request, env);
    if (path === '/kick/reward/list')    return handleKickRewardList(request, env);
    if (path === '/youtube/connect')     return handlePlatformConnect(request, env, PLATFORM_CFG.youtube);
    if (path === '/youtube/callback')    return handlePlatformCallback(request, env, PLATFORM_CFG.youtube);
    if (path === '/youtube/vault/token') return handlePlatformVaultToken(request, env, PLATFORM_CFG.youtube);
    // Desktop app (StreamFusion) browser sign-in for twitch/kick/youtube — opens
    // the system browser, polls for the token (see the /desktop handlers).
    if (path === '/desktop/login')       return handleDesktopLogin(request, env);
    if (path === '/desktop/token')       return handleDesktopToken(request, env);
    // Which connect platforms are configured (booleans only — no secrets). The
    // site /connect UI reads this to show a platform's cards only when ready.
    if (path === '/connect/platforms') return json({
      twitch: !!env.TWITCH_CLIENT_ID,
      kick: !!PLATFORM_CFG.kick.clientId(env),
      youtube: !!PLATFORM_CFG.youtube.clientId(env)
    }, 200);
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
  // moderation:read — Warden's mod-list auto-sync (Helix Get Moderators
  // mirrors the channel's Twitch mods into the Warden team). Added
  // 2026-07-07; streamers who connected earlier need one reconnect.
  'moderation:read',
  // Mod management from the dock (add/remove Twitch moderators) + Warden
  // Shield Mode + AutoMod queue. Added 2026-07-08; needs one reconnect.
  'channel:manage:moderators', 'moderator:manage:shield_mode', 'moderator:manage:automod',
  'channel:manage:raids', 'clips:edit',
  'channel:manage:broadcast', 'channel:manage:ads', 'channel:edit:commercial'
].join(' ');
// A separate bot account only needs to read + post chat as itself.
const BOT_CONNECT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'].join(' ');
function VAULT_KEY(twitchId) { return 'vault:tw:' + twitchId; }

// Bot-connect binds a bot account to a broadcaster's vault under `owner`
// (a Twitch id). Since anyone can hit /twitch/connect directly, `owner` MUST
// be proven — the aquilo.gg /api/connect/start endpoint (which authenticated
// the broadcaster's session) signs it with the shared CONNECT_OWNER_SECRET.
// Without this an attacker could plant their bot token in any streamer's vault.
async function verifyOwnerSig(env, owner, hexSig) {
  if (!env.CONNECT_OWNER_SECRET || !owner || !hexSig) return false;
  try {
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.CONNECT_OWNER_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(owner)));
    var expect = [...new Uint8Array(sig)].map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    if (typeof hexSig !== 'string' || expect.length !== hexSig.length) return false;
    var diff = 0;
    for (var i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ hexSig.charCodeAt(i);
    return diff === 0;
  } catch (e) { return false; }
}

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
// errBox (optional): on failure receives { where, status, body } so a caller
// can relay Twitch's REAL rejection instead of a generic 502. Callers that
// don't pass it keep the original null-on-failure contract untouched.
async function _twitchExchange(env, params, errBox) {
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
  } catch (e) {
    if (errBox) { errBox.where = 'fetch'; errBox.status = 0; errBox.body = String((e && e.message) || e); }
    return null;
  }
  if (!resp.ok) {
    if (errBox) {
      errBox.where = 'twitch';
      errBox.status = resp.status;
      try { errBox.body = await resp.json(); } catch (e) { try { errBox.body = await resp.text(); } catch (e2) { errBox.body = ''; } }
    }
    return null;
  }
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
    } else if (rec.expires_at <= Date.now()) {
      // Refresh failed AND the token is already expired — the session is dead.
      // Return null so /twitch/me reports not-authed (prompting re-auth)
      // instead of handing callers a stale token that will 401 on Helix.
      return null;
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
  // Desktop app (StreamFusion) sign-in reuses this callback via a d:1 marker —
  // it has no return/owner, so branch out before the vault-flow checks below.
  if (state && state.d === 1) return _desktopCallback(env, _desktopCfg(env, 'twitch'), code, session, err);
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
    // Bot mode attaches to the broadcaster's vault (state.o). That id rode
    // through the provider in the state, so re-verify its owner signature —
    // otherwise a streamer could swap `o` and plant their bot in another's
    // vault. (Broadcaster mode keys by u.id from the freshly-authorized token,
    // so it needs no owner check.)
    if (mode === 'bot' && !(await verifyOwnerSig(env, ownerId, String((state && state.os) || '')))) {
      return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=owner') } });
    }
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
    // Merged sign-in (mint=1, broadcaster only): ALSO persist the identity
    // session under the caller's nonce, so aquilo.gg's /api/twitch/link/finish
    // can mint the aq_link login from this SAME consent via /twitch/me — one
    // Twitch prompt instead of two. Guarded to mode==='connect' + state.x so a
    // bot connect can never seed a session, and keyed by u.id (this vault write
    // is broadcaster mode → rec is the account that just authorized), so it
    // cannot seed a session for anyone else.
    if (mode === 'connect' && state && state.x === 1) {
      await env.TWITCH_SESSIONS.put('tw:' + session, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 60 });
    }
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
  var eb = {};
  var t = await _twitchExchange(env, params, eb);
  if (!t) {
    // Relay what actually happened so the desktop app can show a real reason
    // (and so an ops curl with a dummy code proves the pipe end-to-end).
    if (eb.where === 'twitch') return json({ error: 'twitch_rejected', status: eb.status, twitch: eb.body }, 502);
    return json({ error: 'upstream_unreachable', detail: eb.body || '' }, 502);
  }
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
  if (isBot) {
    if (!owner) return json({ error: 'bot_mode_requires_owner' }, 400);
    // `owner` is the broadcaster whose vault the bot attaches to — it must be
    // signed by the site, or an attacker could plant a bot token in anyone's
    // vault by hitting this endpoint directly.
    var osig = url.searchParams.get('osig') || '';
    if (!(await verifyOwnerSig(env, owner, osig))) {
      return json({ error: 'owner_not_authorized' }, 403);
    }
  }
  var scopes = isBot ? BOT_CONNECT_SCOPES : BROADCASTER_CONNECT_SCOPES;
  var redirectUri = env.TWITCH_REDIRECT_URI || TWITCH_CALLBACK_DEFAULT;
  // `os` = the owner signature, carried IN the state so the callback can
  // re-verify it (the state round-trips through the provider and is otherwise
  // tamperable — without this a malicious streamer could swap `o` to poison
  // another streamer's vault/back-pointer).
  // mint=1 (broadcaster only): tag the state so the shared callback ALSO writes
  // an identity session under this nonce — letting ONE broadcaster consent
  // double as the streamer's aquilo.gg sign-in, collapsing sign-in + authorize
  // into a single Twitch prompt. Never honored for bot mode (see callback).
  var stateObj = { s: session, r: ret, m: isBot ? 'bot' : 'connect', o: owner, os: osig };
  if (url.searchParams.get('mint') === '1' && !isBot) stateObj.x = 1;
  var state = _b64urlEncode(JSON.stringify(stateObj));
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

// ── Kick + YouTube channel/bot connect + vault (Aquilo ID, multi-platform) ──
//
// Generic mirror of the Twitch connect/callback/vault-token flow, parameterized
// by PLATFORM_CFG. Reuses the SAME security primitives (verifyOwnerSig binds an
// authorization to the broadcaster's Twitch id via CONNECT_OWNER_SECRET;
// _twitchReturnAllowed, _b64urlEncode/Decode, _appendHash). Vault value shape is
// identical to vault:tw:<id> (broadcaster/bot sub-objects) so consumers read it
// the same way; only the KV prefix, OAuth endpoints, scopes, PKCE (Kick) and
// offline-consent (YouTube) differ.
//
// Identity note: unlike Twitch (owner == the vault key), these platforms key the
// vault by the PLATFORM id but the site authorizes by the streamer's TWITCH id.
// So BOTH modes require an osig-signed `owner` (Twitch id); broadcaster-connect
// writes a link:tw2<platform>:<twitchId> → platformId back-pointer, and
// bot-connect resolves the broadcaster's platform vault through it.
//
// DARK by default: handlers early-return *_not_configured until the platform's
// client id + secret are set on the broker.
var PLATFORM_CFG = {
  kick: {
    key: 'kick',
    authUrl: 'https://id.kick.com/oauth/authorize',
    tokenUrl: 'https://id.kick.com/oauth/token',
    vaultKey: function (id) { return 'vault:kick:' + id; },
    clientId: function (env) { return env.KICK_CONNECT_CLIENT_ID || env.KICK_CLIENT_ID; },
    clientSecret: function (env) { return env.KICK_CONNECT_CLIENT_SECRET || env.KICK_CLIENT_SECRET; },
    redirect: function (env) { return env.KICK_CONNECT_REDIRECT_URI || 'https://auth.aquilo.gg/kick/callback'; },
    broadcasterScopes: 'user:read channel:read channel:write chat:write events:subscribe channel:rewards:read channel:rewards:write',
    botScopes: 'user:read chat:write',
    pkce: true,
    offline: false,
    identity: async function (env, accessToken) {
      var resp;
      try { resp = await fetch('https://api.kick.com/public/v1/users', { headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } }); }
      catch (e) { return null; }
      if (!resp.ok) return null;
      var j; try { j = await resp.json(); } catch (e) { return null; }
      var d = Array.isArray(j && j.data) ? j.data[0] : ((j && j.data) || j);
      if (!d) return null;
      var id = String(d.user_id != null ? d.user_id : (d.id != null ? d.id : ''));
      if (!id) return null;
      var name = String(d.name || d.username || d.slug || '');
      return { id: id, login: name, display_name: name };
    }
  },
  youtube: {
    key: 'youtube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    vaultKey: function (id) { return 'vault:yt:' + id; },
    clientId: function (env) { return env.YOUTUBE_CONNECT_CLIENT_ID || env.YOUTUBE_CLIENT_ID; },
    clientSecret: function (env) { return env.YOUTUBE_CONNECT_CLIENT_SECRET || env.YOUTUBE_CLIENT_SECRET; },
    redirect: function (env) { return env.YOUTUBE_CONNECT_REDIRECT_URI || 'https://auth.aquilo.gg/youtube/callback'; },
    broadcasterScopes: 'openid https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',
    botScopes: 'openid https://www.googleapis.com/auth/youtube.force-ssl',
    pkce: false,
    offline: true,
    identity: async function (env, accessToken) {
      var resp;
      try { resp = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true', { headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } }); }
      catch (e) { return null; }
      if (!resp.ok) return null;
      var j; try { j = await resp.json(); } catch (e) { return null; }
      var it = j && Array.isArray(j.items) ? j.items[0] : null;
      if (!it || !it.id) return null;
      var sn = it.snippet || {};
      return { id: String(it.id), login: String(sn.customUrl || it.id), display_name: String(sn.title || 'YouTube channel') };
    }
  }
};

function _pkceVerifier() {
  var bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  var bin = ''; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function _pkceChallenge(verifier) {
  var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  var b = new Uint8Array(digest);
  var bin = ''; for (var i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function _oauthTokenExchange(env, cfg, params, errBox) {
  var form = new URLSearchParams();
  form.set('client_id', cfg.clientId(env));
  form.set('client_secret', cfg.clientSecret(env));
  Object.keys(params).forEach(function (k) { if (params[k] != null) form.set(k, params[k]); });
  var resp;
  try {
    resp = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: form.toString() });
  } catch (e) { if (errBox) { errBox.where = 'fetch'; errBox.body = String((e && e.message) || e); } return null; }
  if (!resp.ok) {
    if (errBox) { errBox.where = cfg.key; errBox.status = resp.status; try { errBox.body = await resp.json(); } catch (e) { try { errBox.body = await resp.text(); } catch (e2) { errBox.body = ''; } } }
    return null;
  }
  try { return await resp.json(); } catch (e) { return null; }
}

// ── Kick channel-point rewards (shared by every product's customizer) ─────────
// A streamer connects Kick once on /connect; any product's worker can then call
// /kick/reward/ensure (service-secret-guarded) to CREATE (or reuse) a reward on
// that channel using the vault broadcaster token, and /kick/reward/delete to
// remove one. Centralized here so the Kick client secret + the reward API stay
// server-side and each product just proxies its customizer's button.
async function _vaultBroadcasterToken(env, cfg, twitchId, id) {
  if (!env.LOADOUT_BOLTS) return { error: 'vault_not_configured', status: 500 };
  var vaultId = String(id || '');
  if (!vaultId && twitchId) vaultId = (await env.LOADOUT_BOLTS.get('link:tw2' + cfg.key + ':' + String(twitchId))) || '';
  if (!vaultId) return { error: 'missing_id', status: 400 };
  var vraw = await env.LOADOUT_BOLTS.get(cfg.vaultKey(vaultId));
  if (!vraw) return { error: 'not_connected', status: 404 };
  var vault; try { vault = JSON.parse(vraw); } catch (e) { return { error: 'corrupt', status: 500 }; }
  var sub = vault.broadcaster;
  if (!sub || !sub.refresh_token) return { error: 'role_not_connected', status: 404 };
  if (!sub.access_token || !sub.expires_at || (sub.expires_at - Date.now() < 120000)) {
    var t = await _oauthTokenExchange(env, cfg, { grant_type: 'refresh_token', refresh_token: sub.refresh_token }, {});
    if (!t || !t.access_token) return { error: 'refresh_failed', status: 502 };
    sub.access_token = t.access_token;
    if (t.refresh_token) sub.refresh_token = t.refresh_token;
    sub.expires_at = Date.now() + ((t.expires_in || 3600) * 1000);
    sub.scope = Array.isArray(t.scope) ? t.scope.join(' ') : (t.scope || sub.scope);
    vault.broadcaster = sub;
    await env.LOADOUT_BOLTS.put(cfg.vaultKey(vaultId), JSON.stringify(vault));
  }
  return { token: sub.access_token, vaultId: vaultId, scope: sub.scope };
}
async function _kickApi(token, method, path, body) {
  try {
    var r = await fetch('https://api.kick.com/public/v1' + path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) return { _error: true, status: r.status };
    return await r.json().catch(function () { return {}; });
  } catch (e) { return { _error: true, status: 0 }; }
}
// POST /kick/reward/ensure { service, twitchId|id, title, cost, prompt } → creates
// or reuses a same-titled reward. Returns { ok, status, rewardId, title, kickId }.
async function handleKickRewardEnsure(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  var body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
  if (!env.VAULT_SERVICE_SECRET || !body || body.service !== env.VAULT_SERVICE_SECRET) return json({ error: 'unauthorized' }, 401);
  var cfg = PLATFORM_CFG.kick;
  if (!cfg.clientId(env)) return json({ error: 'kick_not_configured' }, 503);
  var got = await _vaultBroadcasterToken(env, cfg, body.twitchId, body.id);
  if (got.error) return json({ error: got.error }, got.status || 400);
  var title = String(body.title || '').trim().slice(0, 50);
  if (!title) return json({ error: 'missing_title' }, 400);
  var cost = Math.max(1, Math.min(1000000, Number(body.cost) || 100));
  var prompt = String(body.prompt || '').slice(0, 200);
  var list = await _kickApi(got.token, 'GET', '/channels/rewards', null);
  var rows = Array.isArray(list && list.data) ? list.data : [];
  var reward = rows.find(function (r) { return String((r && r.title) || '').trim().toLowerCase() === title.toLowerCase(); });
  var status = 'linked';
  if (!reward) {
    var made = await _kickApi(got.token, 'POST', '/channels/rewards', {
      title: title, cost: cost, description: prompt || 'Redeem on Kick', is_user_input_required: !!body.userInput, background_color: '#53fc18',
    });
    reward = (made && made.data) ? made.data : made;
    if (!reward || reward._error || reward.id == null) return json({ error: 'create_failed', detail: (made && made.status) || null }, 502);
    status = 'created';
  }
  return json({ ok: true, status: status, rewardId: String(reward.id), title: reward.title || title, kickId: got.vaultId }, 200);
}
// POST /kick/reward/delete { service, twitchId|id, rewardId }
async function handleKickRewardDelete(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  var body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
  if (!env.VAULT_SERVICE_SECRET || !body || body.service !== env.VAULT_SERVICE_SECRET) return json({ error: 'unauthorized' }, 401);
  var cfg = PLATFORM_CFG.kick;
  var got = await _vaultBroadcasterToken(env, cfg, body.twitchId, body.id);
  if (got.error) return json({ error: got.error }, got.status || 400);
  var rid = String(body.rewardId || '');
  if (!rid) return json({ error: 'missing_reward' }, 400);
  await _kickApi(got.token, 'DELETE', '/channels/rewards/' + encodeURIComponent(rid), null);
  return json({ ok: true }, 200);
}
// POST /kick/reward/list { service, twitchId|id } → the streamer's Kick rewards,
// so a product's customizer can offer "pick an existing reward" instead of
// creating one. Returns { ok, rewards:[{id,title,cost}] }.
async function handleKickRewardList(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  var body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
  if (!env.VAULT_SERVICE_SECRET || !body || body.service !== env.VAULT_SERVICE_SECRET) return json({ error: 'unauthorized' }, 401);
  var cfg = PLATFORM_CFG.kick;
  var got = await _vaultBroadcasterToken(env, cfg, body.twitchId, body.id);
  if (got.error) return json({ error: got.error }, got.status || 400);
  var list = await _kickApi(got.token, 'GET', '/channels/rewards', null);
  var rows = Array.isArray(list && list.data) ? list.data : [];
  return json({ ok: true, rewards: rows.map(function (r) {
    return { id: String((r && r.id != null) ? r.id : ''), title: (r && r.title) || '', cost: (r && r.cost) || 0 };
  }) }, 200);
}

async function handlePlatformConnect(request, env, cfg) {
  if (!cfg.clientId(env)) return json({ error: cfg.key + '_not_configured' }, 500);
  var url = new URL(request.url);
  var session = url.searchParams.get('state') || url.searchParams.get('session') || '';
  var ret = url.searchParams.get('return') || url.searchParams.get('redirect') || '';
  var mode = (url.searchParams.get('mode') || 'broadcaster').toLowerCase();
  var owner = url.searchParams.get('owner') || '';
  var osig = url.searchParams.get('osig') || '';
  if (!session || session.length < 16) return json({ error: 'missing_or_short_session' }, 400);
  if (!ret || !_twitchReturnAllowed(ret)) return json({ error: 'return_not_allowed' }, 400);
  // owner = the broadcaster's Twitch id, signed by the site from the session.
  // Required for BOTH modes here (unlike Twitch) so the tw2<platform> back-
  // pointer that links a streamer to their platform vault is authorized.
  if (!owner) return json({ error: 'owner_required' }, 400);
  if (!(await verifyOwnerSig(env, owner, osig))) return json({ error: 'owner_not_authorized' }, 403);
  var isBot = mode === 'bot';
  var scopes = isBot ? cfg.botScopes : cfg.broadcasterScopes;
  var extra = '';
  if (cfg.pkce) {
    var verifier = _pkceVerifier();
    var challenge = await _pkceChallenge(verifier);
    // Verifier stays server-side (never in the state that round-trips through
    // the provider), keyed by the session nonce with a short TTL.
    if (env.LOADOUT_BOLTS) await env.LOADOUT_BOLTS.put('pkce:' + cfg.key + ':' + session, verifier, { expirationTtl: 600 });
    extra += '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256';
  }
  if (cfg.offline) extra += '&access_type=offline&prompt=consent';
  // `os` = the owner signature, carried IN the state so the callback can
  // re-verify it (the state round-trips through the provider and is otherwise
  // tamperable — without this a malicious streamer could swap `o` to poison
  // another streamer's vault/back-pointer).
  var state = _b64urlEncode(JSON.stringify({ s: session, r: ret, m: isBot ? 'bot' : 'connect', o: owner, os: osig }));
  var authUrl = cfg.authUrl
    + '?client_id=' + encodeURIComponent(cfg.clientId(env))
    + '&redirect_uri=' + encodeURIComponent(cfg.redirect(env))
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scopes)
    + '&state=' + encodeURIComponent(state)
    + extra;
  return new Response(null, { status: 302, headers: { 'Location': authUrl, 'Cache-Control': 'no-store' } });
}

async function handlePlatformCallback(request, env, cfg) {
  var url = new URL(request.url);
  var err = url.searchParams.get('error');
  var code = url.searchParams.get('code');
  var state; try { state = JSON.parse(_b64urlDecode(url.searchParams.get('state') || '')); } catch (e) { state = null; }
  var ret = (state && state.r) || '';
  var session = (state && state.s) || '';
  var mode = (state && state.m) || '';
  var twitchOwner = String((state && state.o) || '');
  var osig = String((state && state.os) || '');
  // Desktop app (StreamFusion) sign-in reuses this callback via a d:1 marker —
  // no vault/owner, so branch out before the connect-flow checks below.
  if (state && state.d === 1) return _desktopCallback(env, cfg, code, session, err);
  if (!ret || !_twitchReturnAllowed(ret) || !session || !twitchOwner || (mode !== 'connect' && mode !== 'bot')) return json({ error: 'bad_state' }, 400);
  // Re-verify the owner signature carried in the state — the state round-trips
  // through the provider, so `o` (twitchOwner) is untrusted until this passes.
  // Without it a streamer could tamper `o` to write into another's vault/pointer.
  if (!(await verifyOwnerSig(env, twitchOwner, osig))) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=owner') } });
  if (err || !code) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, cfg.key + '=error') } });
  if (!cfg.clientId(env) || !cfg.clientSecret(env) || !env.LOADOUT_BOLTS) {
    return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=not_configured') } });
  }
  var params = { grant_type: 'authorization_code', code: code, redirect_uri: cfg.redirect(env) };
  if (cfg.pkce) {
    var verifier = await env.LOADOUT_BOLTS.get('pkce:' + cfg.key + ':' + session);
    if (!verifier) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=pkce') } });
    params.code_verifier = verifier;
    await env.LOADOUT_BOLTS.delete('pkce:' + cfg.key + ':' + session);
  }
  var tok = await _oauthTokenExchange(env, cfg, params, {});
  if (!tok || !tok.access_token) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=exchange') } });
  // A vault we can't refresh is useless — require a refresh token at connect.
  if (!tok.refresh_token) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=no_refresh') } });
  var who = await cfg.identity(env, tok.access_token);
  if (!who || !who.id) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=identity') } });

  // Which platform vault does this write to? Broadcaster: the authorized
  // account itself. Bot: the broadcaster's channel, resolved via the back-
  // pointer written at channel-connect time (so a bot can't be attached before
  // the channel is connected).
  var vaultId;
  if (mode === 'bot') {
    vaultId = await env.LOADOUT_BOLTS.get('link:tw2' + cfg.key + ':' + twitchOwner);
    if (!vaultId) return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=error&reason=connect_channel_first') } });
  } else {
    vaultId = who.id;
  }
  var vkey = cfg.vaultKey(vaultId);
  var vraw = await env.LOADOUT_BOLTS.get(vkey);
  var vault; try { vault = vraw ? JSON.parse(vraw) : {}; } catch (e) { vault = {}; }
  var sub = {
    platformId: who.id, login: who.login, display_name: who.display_name,
    refresh_token: tok.refresh_token, access_token: tok.access_token,
    expires_at: Date.now() + ((tok.expires_in || 3600) * 1000),
    scope: Array.isArray(tok.scope) ? tok.scope.join(' ') : (tok.scope || ''), updatedAt: Date.now()
  };
  if (mode === 'bot') {
    vault.bot = sub;
  } else {
    vault.platformId = who.id; vault.login = who.login; vault.display_name = who.display_name;
    vault.twitchOwner = twitchOwner;
    vault.broadcaster = sub;
    if (!vault.connectedAt) vault.connectedAt = Date.now();
    // Authorize the site to find this vault by the streamer's Twitch id.
    await env.LOADOUT_BOLTS.put('link:tw2' + cfg.key + ':' + twitchOwner, who.id);
  }
  vault.updatedAt = Date.now();
  await env.LOADOUT_BOLTS.put(vkey, JSON.stringify(vault));

  return new Response(null, { status: 302, headers: { 'Location': _appendHash(ret, 'connected=' + cfg.key + '-' + (mode === 'bot' ? 'bot' : 'ok')), 'Cache-Control': 'no-store' } });
}

// ── Desktop app sign-in (StreamFusion) — browser + poll ──────────────────────
// A native app can't safely hold a client secret, so instead of an in-app login
// the app opens the system browser (where the streamer is already logged in) to
// /desktop/login, we run the OAuth here (secret stays server-side) reusing the
// SAME provider callbacks as the vault connect (via a d:1 state marker — so NO
// new redirect URIs to register), stash the token keyed by the app's nonce, and
// the app polls /desktop/token to collect it. The poll is bound to a PKCE
// verifier the app keeps private, so a nonce leaking through the browser URL /
// history can't lift the token. Works identically for twitch/kick/youtube.
function _desktopCfg(env, platform) {
  if (platform === 'kick') return PLATFORM_CFG.kick;
  if (platform === 'youtube') return PLATFORM_CFG.youtube;
  if (platform === 'twitch') return {
    key: 'twitch',
    authUrl: TWITCH_OAUTH + '/authorize',
    tokenUrl: TWITCH_OAUTH + '/token',
    clientId: function (e) { return e.TWITCH_CLIENT_ID; },
    clientSecret: function (e) { return e.TWITCH_CLIENT_SECRET; },
    redirect: function (e) { return e.TWITCH_REDIRECT_URI || TWITCH_CALLBACK_DEFAULT; },
    broadcasterScopes: BROADCASTER_CONNECT_SCOPES,
    botScopes: BOT_CONNECT_SCOPES,
    pkce: false, offline: false,
    identity: async function (e, token) {
      var meRes = await _twitchHelix(e, token, 'GET', 'users', '', null);
      var u = meRes && meRes.data && meRes.data.data && meRes.data.data[0];
      return u ? { id: String(u.id), login: u.login, display_name: u.display_name } : null;
    }
  };
  return null;
}

// GET /desktop/login?platform=&session=<nonce>&challenge=<S256>&mode=broadcaster|bot
async function handleDesktopLogin(request, env) {
  var url = new URL(request.url);
  var platform = (url.searchParams.get('platform') || '').toLowerCase();
  var session = url.searchParams.get('session') || '';
  var challenge = url.searchParams.get('challenge') || '';
  var mode = (url.searchParams.get('mode') || 'broadcaster').toLowerCase() === 'bot' ? 'bot' : 'broadcaster';
  var cfg = _desktopCfg(env, platform);
  if (!cfg) return json({ error: 'bad_platform' }, 400);
  if (!cfg.clientId(env)) return json({ error: platform + '_not_configured' }, 503);
  if (!session || session.length < 16) return json({ error: 'missing_or_short_session' }, 400);
  if (!challenge || challenge.length < 20) return json({ error: 'missing_challenge' }, 400);
  if (!env.LOADOUT_BOLTS) return json({ error: 'not_configured' }, 503);
  var extra = '', pv = '';
  if (cfg.pkce) { pv = _pkceVerifier(); extra += '&code_challenge=' + encodeURIComponent(await _pkceChallenge(pv)) + '&code_challenge_method=S256'; }
  if (cfg.offline) extra += '&access_type=offline&prompt=consent';
  // App's challenge + the provider PKCE verifier stay server-side, keyed by the
  // nonce (never in the state that round-trips through the provider).
  await env.LOADOUT_BOLTS.put('desktop:sess:' + session, JSON.stringify({ p: platform, m: mode, ch: challenge, pv: pv }), { expirationTtl: 600 });
  var scopes = mode === 'bot' ? cfg.botScopes : cfg.broadcasterScopes;
  var state = _b64urlEncode(JSON.stringify({ s: session, p: platform, m: mode, d: 1 }));
  var authUrl = cfg.authUrl
    + '?client_id=' + encodeURIComponent(cfg.clientId(env))
    + '&redirect_uri=' + encodeURIComponent(cfg.redirect(env))
    + '&response_type=code&scope=' + encodeURIComponent(scopes)
    + '&state=' + encodeURIComponent(state) + extra;
  return new Response(null, { status: 302, headers: { 'Location': authUrl, 'Cache-Control': 'no-store' } });
}

// Shared callback for the d:1 desktop flow (called from handleTwitch/PlatformCallback).
async function _desktopCallback(env, cfg, code, session, err) {
  var sessRaw = env.LOADOUT_BOLTS ? await env.LOADOUT_BOLTS.get('desktop:sess:' + session) : null;
  var sess; try { sess = sessRaw ? JSON.parse(sessRaw) : null; } catch (e) { sess = null; }
  if (!sess) return _desktopHtml('This sign-in link expired. Start again in StreamFusion.', false);
  var fail = async function (reason, msg) {
    await env.LOADOUT_BOLTS.put('desktop:tok:' + session, JSON.stringify({ error: reason, ch: sess.ch }), { expirationTtl: 600 });
    await env.LOADOUT_BOLTS.delete('desktop:sess:' + session);
    return _desktopHtml(msg, false);
  };
  if (err || !code) return fail('denied', 'Sign-in was cancelled. You can close this tab.');
  var params = { grant_type: 'authorization_code', code: code, redirect_uri: cfg.redirect(env) };
  if (cfg.pkce && sess.pv) params.code_verifier = sess.pv;
  var tok = await _oauthTokenExchange(env, cfg, params, {});
  if (!tok || !tok.access_token) return fail('exchange', 'Sign-in failed at the token step. Try again in StreamFusion.');
  var who = null; try { who = await cfg.identity(env, tok.access_token); } catch (e) {}
  await env.LOADOUT_BOLTS.put('desktop:tok:' + session, JSON.stringify({
    ok: true, platform: cfg.key,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: tok.expires_in ? (Date.now() + tok.expires_in * 1000) : null,
    scope: Array.isArray(tok.scope) ? tok.scope.join(' ') : (tok.scope || ''),
    identity: who, ch: sess.ch
  }), { expirationTtl: 600 });
  await env.LOADOUT_BOLTS.delete('desktop:sess:' + session);
  return _desktopHtml('Signed in to ' + cfg.key + '. Return to StreamFusion — you can close this tab.', true);
}

// GET /desktop/token?session=<nonce>&verifier=<the app's private PKCE verifier>
async function handleDesktopToken(request, env) {
  var url = new URL(request.url);
  var session = url.searchParams.get('session') || '';
  var verifier = url.searchParams.get('verifier') || '';
  if (!session || !verifier) return json({ error: 'bad_request' }, 400);
  if (!env.LOADOUT_BOLTS) return json({ error: 'not_configured' }, 503);
  var raw = await env.LOADOUT_BOLTS.get('desktop:tok:' + session);
  if (!raw) return json({ pending: true }, 200);      // not finished yet (or expired)
  var rec; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec) return json({ pending: true }, 200);
  // Bind retrieval to the app's private verifier — the nonce alone (visible in
  // the browser URL) must not be enough to lift the token.
  if ((await _pkceChallenge(verifier)) !== rec.ch) return json({ error: 'verifier_mismatch' }, 403);
  await env.LOADOUT_BOLTS.delete('desktop:tok:' + session);   // single use
  if (rec.error) return json({ error: rec.error }, 200);
  return json({ ok: true, platform: rec.platform, access_token: rec.access_token, refresh_token: rec.refresh_token, expires_at: rec.expires_at, scope: rec.scope, identity: rec.identity }, 200);
}

function _desktopHtml(msg, ok) {
  var color = ok ? '#5bff95' : '#ff8a8a';
  var mark = ok ? '✓' : '✕';
  var body = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamFusion</title>'
    + '<div style="font-family:system-ui,-apple-system,sans-serif;background:#0e0f13;color:#e7e9ee;min-height:100vh;display:grid;place-items:center;margin:0">'
    + '<div style="text-align:center;padding:32px 24px;max-width:440px">'
    + '<div style="font-size:46px;line-height:1;margin-bottom:12px;color:' + color + '">' + mark + '</div>'
    + '<div style="font-size:16px;line-height:1.55">' + msg + '</div></div></div>';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// POST /<platform>/vault/token { service, id|twitchId, role:'broadcaster'|'bot' }
async function handlePlatformVaultToken(request, env, cfg) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  var body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
  if (!env.VAULT_SERVICE_SECRET || !body || body.service !== env.VAULT_SERVICE_SECRET) return json({ error: 'unauthorized' }, 401);
  if (!cfg.clientId(env)) return json({ error: cfg.key + '_not_configured' }, 500);
  if (!env.LOADOUT_BOLTS) return json({ error: 'vault_not_configured' }, 500);
  var role = body.role === 'bot' ? 'bot' : 'broadcaster';
  var vaultId = String(body.id || body[cfg.key + 'Id'] || '');
  if (!vaultId && body.twitchId) vaultId = (await env.LOADOUT_BOLTS.get('link:tw2' + cfg.key + ':' + String(body.twitchId))) || '';
  if (!vaultId) return json({ error: 'missing_id' }, 400);
  var vraw = await env.LOADOUT_BOLTS.get(cfg.vaultKey(vaultId));
  if (!vraw) return json({ error: 'not_connected' }, 404);
  var vault; try { vault = JSON.parse(vraw); } catch (e) { return json({ error: 'corrupt' }, 500); }
  var sub = role === 'bot' ? vault.bot : vault.broadcaster;
  if (!sub || !sub.refresh_token) return json({ error: 'role_not_connected', role: role }, 404);
  if (!sub.access_token || !sub.expires_at || (sub.expires_at - Date.now() < 120000)) {
    var t = await _oauthTokenExchange(env, cfg, { grant_type: 'refresh_token', refresh_token: sub.refresh_token }, {});
    if (!t || !t.access_token) return json({ error: 'refresh_failed' }, 502);
    sub.access_token = t.access_token;
    if (t.refresh_token) sub.refresh_token = t.refresh_token;
    sub.expires_at = Date.now() + ((t.expires_in || 3600) * 1000);
    sub.scope = Array.isArray(t.scope) ? t.scope.join(' ') : (t.scope || sub.scope);
    sub.updatedAt = Date.now();
    if (role === 'bot') vault.bot = sub; else vault.broadcaster = sub;
    await env.LOADOUT_BOLTS.put(cfg.vaultKey(vaultId), JSON.stringify(vault));
  }
  return json({ ok: true, access_token: sub.access_token, expires_at: sub.expires_at, scope: sub.scope, login: sub.login, client_id: cfg.clientId(env) }, 200);
}
