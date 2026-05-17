// StreamFusion release-notes Worker.
//
// Splits the /post-release endpoint out of bot-service/index.js into its
// own Cloudflare Worker. The rest of bot-service (Gateway WebSocket + SSE
// fan-out for EA users' Discord events) STAYS on Railway because Workers
// can't hold persistent outbound WebSockets to Discord's gateway, and SSE
// long-lived clients don't fit Workers' per-request lifecycle.
//
// What this Worker does:
//   POST /post-release       - shared-secret auth, posts a release-note
//                              embed to a configured Discord channel
//                              using the bot token. Identical contract
//                              to the existing Railway endpoint, so the
//                              GitHub release workflow swaps URLs and
//                              that's it.
//   GET  /health             - liveness probe
//
// Why split:
//   - Workers free tier = 100k req/day. Release posts are infrequent
//     (≤a few per day). Free forever in practice.
//   - The Railway dyno stays for Gateway + SSE; smaller surface =
//     simpler service + the heavy "always-on" workload is the only
//     thing that needs to be there.
//
// Secrets (set via `wrangler secret put`):
//   DISCORD_BOT_TOKEN    - the SF bot token (same one bot-service uses)
//   RELEASE_POST_SECRET  - shared secret. Match what GitHub Actions sends.

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === 'GET' && (path === '/' || path === '/health'))
      return new Response('sf-release-worker ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (req.method === 'POST' && path === '/post-release') return handlePostRelease(req, env);
    return new Response('not found', { status: 404 });
  }
};

async function handlePostRelease(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  if (!env.RELEASE_POST_SECRET) return json({ ok: false, error: 'disabled' }, 503);
  if (body.secret !== env.RELEASE_POST_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

  const channelId = String(body.channelId || '').trim();
  if (!/^\d{15,25}$/.test(channelId)) return json({ ok: false, error: 'invalid_channel_id' }, 400);
  if (!env.DISCORD_BOT_TOKEN) return json({ ok: false, error: 'no_bot_token' }, 500);

  // Mirror the existing logic in bot-service/index.js handlePostRelease.
  // Discord caps embed.description at 4096 chars. Truncate gracefully and
  // append a "full notes on GitHub" link so we don't lose the trail.
  const MAX = 4096;
  let desc = String(body.summary || body.body || '');
  const truncSuffix = '\n\n[Full release notes on GitHub →](' + (body.url || '#') + ')';
  if (body.summary) {
    if ((desc.length + truncSuffix.length) <= MAX) desc = desc + truncSuffix;
    else desc = desc.slice(0, MAX - truncSuffix.length - 20).replace(/\n[^\n]*$/, '') + '\n…' + truncSuffix;
  } else if (desc.length > MAX) {
    desc = desc.slice(0, MAX - 80).replace(/\n[^\n]*$/, '') + '\n\n… [full notes on GitHub →](' + (body.url || '#') + ')';
  }

  const embed = {
    title:       String(body.title || ('StreamFusion ' + (body.version || ''))).slice(0, 256),
    description: desc,
    url:         body.url || undefined,
    color:       typeof body.color === 'number' ? body.color : 0x3A86FF,
    timestamp:   new Date().toISOString(),
    footer:      { text: 'StreamFusion v' + (body.version || '?') }
  };

  const payload = { embeds: [embed], allowed_mentions: { parse: [] } };
  const pingRoleId = body.pingRoleId ? String(body.pingRoleId).trim() : '';
  if (pingRoleId && /^\d{15,25}$/.test(pingRoleId)) {
    payload.content = '<@&' + pingRoleId + '>';
    payload.allowed_mentions = { parse: [], roles: [pingRoleId] };
  }

  try {
    const resp = await fetch('https://discord.com/api/v10/channels/' + encodeURIComponent(channelId) + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type':  'application/json',
        'User-Agent':    'StreamFusion-release-worker (1.0)'
      },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const t = await resp.text();
      return json({ ok: false, error: 'discord_' + resp.status, response: t.slice(0, 300) }, 502);
    }
    const j = await resp.json();
    return json({ ok: true, messageId: j.id, channelId });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
