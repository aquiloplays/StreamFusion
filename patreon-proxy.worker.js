// Cloudflare Worker for StreamFusion — four jobs:
//
//   1. /  (or anything not otherwise matched)
//      Patreon OAuth token-exchange proxy. Holds the Patreon client_secret
//      so it never ships in the app binary. Accepts POSTs with grant_type
//      of authorization_code or refresh_token, adds client_id + secret,
//      forwards to Patreon, returns the response verbatim.
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
    // Default: Patreon token proxy (unchanged behavior from before).
    return handlePatreonTokenProxy(request, env);
  }
};

// ── Patreon token exchange proxy ───────────────────────────────────────────
async function handlePatreonTokenProxy(request, env) {
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
  if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET) {
    return json({ error: 'proxy_not_configured' }, 500);
  }

  var form = new URLSearchParams();
  form.set('grant_type', grant);
  form.set('client_id', env.PATREON_CLIENT_ID);
  form.set('client_secret', env.PATREON_CLIENT_SECRET);

  if (grant === 'authorization_code') {
    if (!body.code || !body.redirect_uri) return json({ error: 'missing_code_or_redirect' }, 400);
    var allowed = (env.ALLOWED_REDIRECT_HOSTS || '127.0.0.1').split(',').map(function(s) { return s.trim(); });
    var u;
    try { u = new URL(body.redirect_uri); } catch (e) { return json({ error: 'invalid_redirect_uri' }, 400); }
    if (allowed.indexOf(u.hostname) === -1) return json({ error: 'redirect_host_not_allowed' }, 400);
    form.set('code', body.code);
    form.set('redirect_uri', body.redirect_uri);
  } else {
    if (!body.refresh_token) return json({ error: 'missing_refresh_token' }, 400);
    form.set('refresh_token', body.refresh_token);
  }

  var patreonResp;
  try {
    patreonResp = await fetch('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'StreamFusion-EA-Proxy'
      },
      body: form.toString()
    });
  } catch (e) { return json({ error: 'upstream_unreachable', detail: String(e) }, 502); }

  var text = await patreonResp.text();
  return new Response(text, {
    status: patreonResp.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

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
    var allowed = (env.ALLOWED_REDIRECT_HOSTS || '127.0.0.1').split(',').map(function(s) { return s.trim(); });
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

  // Basic shape check — we expect { embed, streamerName? }.
  var srcEmbed = body && body.embed;
  if (!srcEmbed || typeof srcEmbed !== 'object') {
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
