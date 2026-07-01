// aquilo-favorites — cloud sync for StreamFusion "Stream Info" favorites.
//
// Stores a per-user list of stream-info presets in Cloudflare KV so favorites
// travel between machines. Scoped by the user's *Twitch* identity (the stable
// cross-machine id SF manages, replacing Patreon 2026-06-30) plus the linked
// Twitch channel id, so a streamer who runs multiple channels keeps separate
// favorite sets.
//
// Auth: the caller passes its Twitch access token as a Bearer. The Worker
// verifies it against Helix /users and derives the user id server-side — the
// client can't spoof another user's id. Token→id is cached in KV (10 min) so we
// don't hit Helix on every request. SF's main process attaches the token (the
// renderer never sees it).
//
// Endpoints:
//   GET  /health                      liveness
//   GET  /favorites?twitchId=<id>     -> { ok, favorites:[], updatedAt }
//   PUT  /favorites?twitchId=<id>     body { favorites:[], updatedAt } -> { ok, updatedAt }
//
// The client owns the whole array (add/edit/delete/reorder/pin all mutate it
// locally then PUT the result). Last-write-wins via updatedAt — fine for the
// small, single-user favorites payload.
//
// KV namespace binding: FAVORITES  (create with `wrangler kv namespace create FAVORITES`,
// then paste the id into wrangler.toml).

const MAX_FAVORITES   = 500;
const MAX_PAYLOAD      = 256 * 1024;   // 256 KB hard cap per scope
const TOKEN_CACHE_TTL  = 600;          // seconds

export default {
  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (req.method === 'GET' && (path === '/' || path === '/health'))
      return new Response('aquilo-favorites ok', { status: 200, headers: { 'content-type': 'text/plain' } });

    if (path === '/favorites') {
      if (!env.FAVORITES) return json({ ok: false, error: 'kv_unbound' }, 503);

      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) return json({ ok: false, error: 'no_token' }, 401);

      const uid = await resolveTwitchUserId(token, env);
      if (!uid) return json({ ok: false, error: 'invalid_token' }, 401);

      const twitchId = (url.searchParams.get('twitchId') || '').replace(/[^0-9]/g, '') || 'default';
      const key = 'fav:' + uid + ':' + twitchId;

      if (req.method === 'GET') {
        const raw = await env.FAVORITES.get(key);
        const data = raw ? safeParse(raw) : null;
        return json({ ok: true, favorites: (data && data.favorites) || [], updatedAt: (data && data.updatedAt) || 0 });
      }

      if (req.method === 'PUT') {
        let body;
        try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
        const favorites = Array.isArray(body.favorites) ? body.favorites : [];
        if (favorites.length > MAX_FAVORITES) return json({ ok: false, error: 'too_many' }, 400);
        const updatedAt = Number(body.updatedAt) || Date.now();
        const payload = JSON.stringify({ favorites, updatedAt });
        if (payload.length > MAX_PAYLOAD) return json({ ok: false, error: 'too_large' }, 400);
        await env.FAVORITES.put(key, payload);
        return json({ ok: true, updatedAt });
      }

      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    // ── Bot config sync ─────────────────────────────────────────────────────
    // Shared contract between StreamFusion desktop and aquilo.gg's web bot UI:
    // both read/write the SAME versioned bundle so a streamer's commands,
    // automated messages, auto-mod, quotes, giveaway and schedule settings are
    // identical everywhere. Same auth as /favorites (Bearer = Twitch access
    // token, uid derived server-side). Last-write-wins via updatedAt; clients
    // must adopt the winning side's updatedAt after reconciling.
    //   GET /bot-config?twitchId=<id>  -> { ok, config:{}|null, updatedAt }
    //   PUT /bot-config?twitchId=<id>  body { config:{}, updatedAt } -> { ok, updatedAt }
    // config shape (v1, defined in SF index.html sfBotConfig()):
    //   { v:1, updatedAt, commands:[], autoMessages:{}, automod:{}, quotes:[],
    //     giveaway:{}, schedule:{} }
    // Bot ACCOUNT tokens are never part of this payload; each client does its
    // own OAuth. Execution locality (which client actually posts) is also NOT
    // synced; it is a per-device choice.
    if (path === '/bot-config') {
      if (!env.FAVORITES) return json({ ok: false, error: 'kv_unbound' }, 503);

      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) return json({ ok: false, error: 'no_token' }, 401);

      const uid = await resolveTwitchUserId(token, env);
      if (!uid) return json({ ok: false, error: 'invalid_token' }, 401);

      const twitchId = (url.searchParams.get('twitchId') || '').replace(/[^0-9]/g, '') || 'default';
      const key = 'botcfg:' + uid + ':' + twitchId;

      if (req.method === 'GET') {
        const raw = await env.FAVORITES.get(key);
        const data = raw ? safeParse(raw) : null;
        return json({ ok: true, config: (data && data.config) || null, updatedAt: (data && data.updatedAt) || 0 });
      }

      if (req.method === 'PUT') {
        let body;
        try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
        const config = (body.config && typeof body.config === 'object') ? body.config : null;
        if (!config) return json({ ok: false, error: 'no_config' }, 400);
        const updatedAt = Number(body.updatedAt) || Date.now();
        const payload = JSON.stringify({ config, updatedAt });
        if (payload.length > MAX_PAYLOAD) return json({ ok: false, error: 'too_large' }, 400);
        await env.FAVORITES.put(key, payload);
        return json({ ok: true, updatedAt });
      }

      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    return json({ ok: false, error: 'not_found' }, 404);
  }
};

// Verify a Twitch access token and return the stable Twitch user id (replaces
// Patreon 2026-06-30). Cached in KV (keyed by a hash of the token).
async function resolveTwitchUserId(token, env) {
  const cacheKey = 'tok:' + (await sha256hex(token));
  const cached = await env.FAVORITES.get(cacheKey);
  if (cached) return cached;

  const clientId = env.TWITCH_CLIENT_ID || '24i7na6gc2j9glbeee8450eydmd3qw';
  let resp;
  try {
    resp = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: 'Bearer ' + token, 'Client-Id': clientId, 'User-Agent': 'aquilo-favorites-worker' }
    });
  } catch { return null; }
  if (!resp.ok) return null;

  let j;
  try { j = await resp.json(); } catch { return null; }
  const uid = j && j.data && j.data[0] && j.data[0].id ? String(j.data[0].id) : null;
  if (!uid) return null;

  await env.FAVORITES.put(cacheKey, uid, { expirationTtl: TOKEN_CACHE_TTL });
  return uid;
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'authorization,content-type');
  return resp;
}

function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }));
}
