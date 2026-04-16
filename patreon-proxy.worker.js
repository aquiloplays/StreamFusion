// Cloudflare Worker — Patreon token-exchange proxy for StreamFusion EA.
//
// The StreamFusion EA desktop app does NOT ship the Patreon client_secret.
// When the app needs to exchange an OAuth authorization code (or refresh
// token) for an access token, it POSTs to this Worker instead. The Worker
// adds client_id + client_secret from its secret store, forwards the
// request to Patreon, and returns the response to the app.
//
// Deploy:
//   1. wrangler init or create a new Worker in the Cloudflare dashboard
//   2. Set these secrets:
//        wrangler secret put PATREON_CLIENT_ID
//        wrangler secret put PATREON_CLIENT_SECRET
//      (or add them as encrypted env vars in the dashboard)
//   3. Optionally set ALLOWED_REDIRECT_HOSTS as a plaintext var, comma-
//      separated, e.g. "127.0.0.1,localhost". Defaults to "127.0.0.1".
//   4. Bind a route like auth.aquilo.gg/patreon/token to this Worker.
//   5. Update TOKEN_PROXY_URL in patreon-auth.js to match.
//
// Security posture:
//   - Requires POST + application/json. Rejects everything else.
//   - Only forwards grant_type=authorization_code or refresh_token — never
//     any other grant. No way for a random caller to get new scopes.
//   - Validates redirect_uri host is in ALLOWED_REDIRECT_HOSTS (prevents a
//     caller tricking the proxy into honoring an attacker-controlled URL).
//   - Returns Patreon's body verbatim. No token ever touches our storage.
//   - No CORS headers — the desktop app calls from Node (main process), so
//     cross-origin isn't a concern. Browsers are rejected by the lack of
//     CORS preflight response, which is intentional.

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    var body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'invalid_json' }, 400);
    }

    var grant = body && body.grant_type;
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      return json({ error: 'unsupported_grant_type' }, 400);
    }

    if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET) {
      return json({ error: 'proxy_not_configured' }, 500);
    }

    // Build the form-encoded payload Patreon expects.
    var form = new URLSearchParams();
    form.set('grant_type', grant);
    form.set('client_id', env.PATREON_CLIENT_ID);
    form.set('client_secret', env.PATREON_CLIENT_SECRET);

    if (grant === 'authorization_code') {
      if (!body.code || !body.redirect_uri) {
        return json({ error: 'missing_code_or_redirect' }, 400);
      }
      // Defend against a caller asking us to exchange a code for a token
      // destined for an attacker-controlled redirect. The Patreon OAuth
      // client config is the final source of truth — Patreon will reject
      // any redirect_uri that isn't whitelisted there — but we also block
      // obviously non-loopback hosts here as defense-in-depth.
      var allowed = (env.ALLOWED_REDIRECT_HOSTS || '127.0.0.1').split(',').map(function(s) { return s.trim(); });
      var url;
      try { url = new URL(body.redirect_uri); } catch (e) { return json({ error: 'invalid_redirect_uri' }, 400); }
      if (allowed.indexOf(url.hostname) === -1) {
        return json({ error: 'redirect_host_not_allowed' }, 400);
      }
      form.set('code', body.code);
      form.set('redirect_uri', body.redirect_uri);
    } else {
      if (!body.refresh_token) {
        return json({ error: 'missing_refresh_token' }, 400);
      }
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
    } catch (e) {
      return json({ error: 'upstream_unreachable', detail: String(e) }, 502);
    }

    var text = await patreonResp.text();
    // Pass through Patreon's response body + status. We don't rewrite the
    // shape — keeping it transparent means patreon-auth.js parses exactly
    // what Patreon returns today and any future.
    return new Response(text, {
      status: patreonResp.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
