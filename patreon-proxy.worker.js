// Cloudflare Worker for StreamFusion — two jobs:
//
//   1. /  (or anything not under /community-recap)
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
// Deploy:
//   1. wrangler init or create a Worker in the Cloudflare dashboard
//   2. Paste this file as the Worker script
//   3. Set secrets (wrangler secret put OR dashboard → Variables):
//        PATREON_CLIENT_ID
//        PATREON_CLIENT_SECRET
//        COMMUNITY_RECAP_WEBHOOK     ← Discord webhook URL for your #stream-recaps
//      Optional plaintext vars:
//        ALLOWED_REDIRECT_HOSTS = "127.0.0.1"
//   4. Bind route auth.aquilo.gg/* to this Worker (optional)
//
// Security posture:
//   - Each endpoint has narrow, method-specific validation
//   - Webhook URL is never returned to clients; only embed forwarded
//   - No CORS headers — browsers are rejected by design; only the
//     desktop app (Node-side https.request) has any business calling this

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/community-recap') {
      return handleCommunityRecap(request, env);
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
