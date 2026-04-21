// StreamFusion shared Discord bot + SSE push service.
//
// Runs on Railway (or any always-on Node host). Maintains a single
// Discord Gateway WebSocket connection using ONE bot token — the
// aquilo.gg StreamFusion bot. EA supporters invite that bot to their own
// server; StreamFusion on their machine connects to this service via
// SSE; the service routes Discord events from their guild back to their
// StreamFusion instance.
//
// Discord only allows ONE Gateway connection per bot token, so running
// the bot here (instead of per-user inside each StreamFusion install) is
// the only way to have one bot across many supporters.
//
// Auth model: SF passes the user's Patreon access token on every
// request. We call Patreon's /identity endpoint to verify active Tier 2
// or Tier 3 membership against the configured campaign. No membership =
// no connection.
//
// Storage: in-memory Maps. Associations don't survive a restart; SF
// clients will re-send their association when they reconnect their SSE.
//
// Environment variables (set on Railway):
//   DISCORD_BOT_TOKEN          Your Discord bot token (from the dev portal)
//   DISCORD_BOT_CLIENT_ID      Your Discord bot client/app id (for invite URL)
//   PATREON_CAMPAIGN_ID        Your Patreon campaign id
//   PATREON_TIER2_ID           Tier 2 id (the Early Access tier)
//   PATREON_TIER3_ID           Tier 3 id (the Contributor tier)
//   PORT                       Provided by Railway; defaults to 8080

'use strict';

const http = require('http');
const WebSocket = require('ws');

const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN     || '';
const DISCORD_BOT_CLIENT_ID = process.env.DISCORD_BOT_CLIENT_ID || '';
const PATREON_CAMPAIGN_ID   = process.env.PATREON_CAMPAIGN_ID   || '';
const PATREON_TIER2_ID      = process.env.PATREON_TIER2_ID      || '';
const PATREON_TIER3_ID      = process.env.PATREON_TIER3_ID      || '';
const PORT                  = parseInt(process.env.PORT, 10) || 8080;

// Comma-separated list of email addresses that always get Tier 3 access
// regardless of actual Patreon membership. Needed so the creator (who
// can't pledge to their own Patreon) can use the shared bot to test.
// Mirrors the OWNER_EMAILS list in patreon-auth.js on the desktop side.
const OWNER_EMAILS = (process.env.OWNER_EMAILS || '')
  .split(',')
  .map(function(s) { return s.trim().toLowerCase(); })
  .filter(Boolean);

// Shared-secret for the /post-release webhook. Only callers that know
// this secret can post release announcements through the bot. Set on
// Railway via env var. If unset, the endpoint is disabled.
const RELEASE_POST_SECRET = process.env.RELEASE_POST_SECRET || '';

// Permissions the bot needs on invite. Before 1.5.1 this was just
// VIEW_CHANNEL (1024) — enough for the EA member/voice-join read-only
// use case, but insufficient for the /post-release write path which
// needs to send embeds. The bot would show up in the server but any
// REST POST to a channel would 403 Missing Access.
//
//   VIEW_CHANNEL          1024   (1 << 10)
//   SEND_MESSAGES         2048   (1 << 11)
//   EMBED_LINKS          16384   (1 << 14)
//   READ_MESSAGE_HISTORY 65536   (1 << 16)
//   ─────────────────────────────
//   total                84992
//
// Bumping now so a fresh invite grants everything the bot needs to post
// release notes AND observe joins. Server owners can still scope the
// bot down channel-by-channel after inviting if they want stricter
// control.
const BOT_INVITE_PERMISSIONS = '84992';
const BOT_INVITE_URL = DISCORD_BOT_CLIENT_ID
  ? 'https://discord.com/api/oauth2/authorize?client_id=' + DISCORD_BOT_CLIENT_ID
    + '&permissions=' + BOT_INVITE_PERMISSIONS
    + '&scope=bot'
  : '';

// ── State ──────────────────────────────────────────────────────────────
// guildId → Set<patreonUserId>       who receives events from this guild
// patreonUserId → Set<sseClient>     active SSE push channels for this user
// sseClient: { res, patreonUserId, guildId, heartbeat }
const guildSubscribers   = new Map();
const userConnections    = new Map();

// Patreon identity cache so we don't hammer Patreon on every SSE event.
// Keyed by access token; value = { userId, entitled, tier, expiresAt }
// Entries expire after 5 minutes.
const patreonCache = new Map();
const PATREON_CACHE_TTL = 5 * 60 * 1000;

// ── Discord Gateway connection ─────────────────────────────────────────
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS =
  (1 << 0)  |   // GUILDS
  (1 << 1)  |   // GUILD_MEMBERS (privileged — must be enabled in dev portal)
  (1 << 7)  |   // GUILD_VOICE_STATES
  (1 << 9);     // GUILD_MESSAGES

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let sessionId = null;
let resumeUrl = null;
let lastSequence = null;
let isClosing = false;

// Bot identity + joined-guilds tracking. Populated as Discord's Gateway
// dispatches READY + GUILD_CREATE / GUILD_DELETE events. Surfaced via
// /health so operators can verify the bot is actually in the server
// they expect. Was missing before 1.5.1 — /health only reported
// SUBSCRIBED guilds (EA user associations) which misled one operator
// into thinking the bot had joined zero servers.
let botUser = null;                         // { id, username, discriminator, ... }
const joinedGuilds = new Map();             // guildId → { name, memberCount, joinedAt }

function sendGateway(op, d) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ op: op, d: d })); } catch (e) { console.error('[gw] send failed', e.message); }
}

// Canonical presence payload. Shared between the IDENTIFY frame and
// the standalone PRESENCE_UPDATE refresh below so they can't drift.
const PRESENCE_PAYLOAD = {
  status: 'online',
  activities: [{
    name: 'StreamFusion',
    type: 3   // Watching
  }],
  since: null,
  afk: false
};

function identify() {
  // Explicit presence on IDENTIFY so the bot reliably shows as ONLINE
  // to users in the server. Without this, Discord's default presence
  // handling can leave bots showing as offline in the member list even
  // while the Gateway socket is healthy — which is exactly what was
  // happening on the SF community server before 1.5.1.
  sendGateway(2, {
    token: DISCORD_BOT_TOKEN,
    intents: INTENTS,
    presence: PRESENCE_PAYLOAD,
    properties: { os: process.platform, browser: 'StreamFusion-bot', device: 'StreamFusion-bot' }
  });
}

// Standalone OP 3 PRESENCE_UPDATE. Used as a belt-and-suspenders
// refresh after READY / RESUMED and on a periodic timer. Presence set
// on IDENTIFY is supposed to persist, but in practice Discord's
// presence gossip can drift — especially after a RESUME, which
// restores session state but NOT the presence from the original
// IDENTIFY. Re-sending explicitly corrects that.
function sendPresence() {
  sendGateway(3, PRESENCE_PAYLOAD);
}

function resumeSession() {
  if (!sessionId || lastSequence == null) { identify(); return; }
  sendGateway(6, { token: DISCORD_BOT_TOKEN, session_id: sessionId, seq: lastSequence });
}

function startHeartbeat(intervalMs) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  setTimeout(function() {
    sendGateway(1, lastSequence);
    heartbeatTimer = setInterval(function() { sendGateway(1, lastSequence); }, intervalMs);
  }, Math.random() * intervalMs);
}

function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// Event dispatch — fan out to every SF client subscribed to the matching guild.
function dispatchToGuild(guildId, payload) {
  const subs = guildSubscribers.get(guildId);
  if (!subs) return;
  subs.forEach(function(patreonUserId) {
    const conns = userConnections.get(patreonUserId);
    if (!conns) return;
    conns.forEach(function(client) {
      try {
        client.res.write('event: discord\ndata: ' + JSON.stringify(payload) + '\n\n');
      } catch (e) { /* will be cleaned up on next push */ }
    });
  });
}

function handleDispatch(eventName, data) {
  switch (eventName) {
    case 'READY':
      sessionId = data.session_id;
      resumeUrl = data.resume_gateway_url;
      botUser = data.user || null;
      // Clear stale guild map on reconnect — GUILD_CREATE events will
      // repopulate it (Discord sends one GUILD_CREATE per joined guild
      // right after READY).
      joinedGuilds.clear();
      console.log('[gw] READY — bot user:', botUser && botUser.username, '— in', (data.guilds || []).length, 'guilds');
      // Re-assert presence right after READY. The IDENTIFY frame
      // already carried it, but an explicit OP 3 here defends against
      // the case where Discord's presence broadcast raced the READY
      // and some members never saw the bot come online.
      sendPresence();
      break;
    case 'RESUMED':
      // After a successful OP 6 RESUME, Gateway state is restored but
      // presence is not — the bot will silently show as offline until
      // the next full reconnect unless we re-send it here.
      console.log('[gw] RESUMED — re-asserting presence');
      sendPresence();
      break;
    case 'GUILD_CREATE':
      // Fires for each guild the bot is already in on startup, AND when
      // the bot is newly invited to a guild. Track it so /health can
      // report an accurate joined-guild list to operators.
      joinedGuilds.set(data.id, {
        name: data.name || '(unknown)',
        memberCount: data.member_count,
        joinedAt: Date.now()
      });
      console.log('[gw] GUILD_CREATE', data.id, data.name || '', '(member count:', data.member_count, ')');
      break;
    case 'GUILD_DELETE':
      // Fires when bot is kicked / guild is deleted / guild becomes
      // unavailable. If unavailable:true the bot is still a member; we
      // keep the entry. Otherwise drop it.
      if (!data.unavailable) {
        joinedGuilds.delete(data.id);
        console.log('[gw] GUILD_DELETE', data.id, '(bot removed)');
      }
      break;
    case 'GUILD_MEMBER_ADD': {
      const u = data.user || {};
      dispatchToGuild(data.guild_id, {
        kind: 'member_add',
        guildId: data.guild_id,
        userId: u.id,
        username: u.global_name || u.username || 'Unknown',
        displayName: data.nick || u.global_name || u.username,
        avatarHash: u.avatar
      });
      break;
    }
    case 'VOICE_STATE_UPDATE': {
      if (!data.channel_id) break; // left voice — not forwarded
      const m = (data.member && data.member.user) || {};
      dispatchToGuild(data.guild_id, {
        kind: 'voice_join',
        guildId: data.guild_id,
        channelId: data.channel_id,
        userId: data.user_id,
        username: m.global_name || m.username || data.user_id
      });
      break;
    }
    case 'MESSAGE_CREATE': {
      const a = data.author || {};
      if (a.bot) break; // skip bot messages (our own webhook posts, etc.)
      if (!data.guild_id) break; // DMs ignored
      dispatchToGuild(data.guild_id, {
        kind: 'message',
        guildId: data.guild_id,
        channelId: data.channel_id,
        userId: a.id,
        username: a.global_name || a.username || 'Unknown',
        content: data.content || ''
      });
      break;
    }
  }
}

function handleGatewayMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.s != null) lastSequence = msg.s;
  switch (msg.op) {
    case 10: // HELLO
      startHeartbeat(msg.d.heartbeat_interval);
      if (sessionId && lastSequence != null) resumeSession();
      else identify();
      break;
    case 1:  sendGateway(1, lastSequence); break;  // HEARTBEAT requested
    case 11: break;                                 // HEARTBEAT_ACK
    case 9:  // INVALID_SESSION
      sessionId = null; lastSequence = null;
      setTimeout(identify, 2000 + Math.random() * 3000);
      break;
    case 7:  // RECONNECT
      try { ws.close(4000, 'reconnect'); } catch (e) {}
      break;
    case 0:  handleDispatch(msg.t, msg.d); break;   // DISPATCH
  }
}

function connectGateway() {
  if (!DISCORD_BOT_TOKEN) {
    console.error('[gw] DISCORD_BOT_TOKEN not set — bot will not connect');
    return;
  }
  const url = resumeUrl ? (resumeUrl + '/?v=10&encoding=json') : GATEWAY_URL;
  ws = new WebSocket(url);
  ws.on('open', function() { console.log('[gw] connected to', url); });
  ws.on('message', function(data) { handleGatewayMessage(data.toString()); });
  ws.on('error', function(err) { console.error('[gw] error:', err.message); });
  ws.on('close', function(code, reason) {
    console.log('[gw] closed:', code, reason && reason.toString());
    stopHeartbeat();
    // Unrecoverable codes (auth failed, disallowed intent, etc.) — stop trying.
    const unrecoverable = [4004, 4010, 4011, 4012, 4013, 4014];
    if (!isClosing && unrecoverable.indexOf(code) === -1 && !reconnectTimer) {
      reconnectTimer = setTimeout(function() {
        reconnectTimer = null;
        connectGateway();
      }, 5000 + Math.random() * 5000);
    }
  });
}

// ── Patreon verification ───────────────────────────────────────────────
// Calls /identity?include=memberships,memberships.currently_entitled_tiers
// and returns { userId, entitled, tier }. Entitled = active_patron AND
// on tier2 or tier3 of the configured campaign.
function verifyPatreon(accessToken) {
  return new Promise(function(resolve) {
    // Cache
    const cached = patreonCache.get(accessToken);
    if (cached && cached.expiresAt > Date.now()) { resolve(cached); return; }

    // Include the user's email so we can match against OWNER_EMAILS for
    // the creator bypass. patron_status + currently_entitled_tiers is
    // still the source of truth for actual Tier 2/3 supporters.
    const url = 'https://www.patreon.com/api/oauth2/v2/identity'
              + '?include=memberships,memberships.currently_entitled_tiers'
              + '&fields%5Bmember%5D=patron_status'
              + '&fields%5Buser%5D=email,full_name';
    fetch(url, { headers: { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'StreamFusion-bot' } })
      .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }); })
      .then(function(r) {
        if (r.status !== 200 || !r.body || !r.body.data) {
          const result = { userId: null, entitled: false, tier: 'none', expiresAt: Date.now() + PATREON_CACHE_TTL };
          patreonCache.set(accessToken, result);
          resolve(result);
          return;
        }
        const userId = r.body.data.id;
        const attrs = r.body.data.attributes || {};
        const email = (attrs.email || '').toLowerCase();

        // Owner bypass — the creator signs in with their own Patreon
        // account (not a patron of their own campaign) so they need
        // explicit allow-listing to use the shared bot.
        if (email && OWNER_EMAILS.indexOf(email) !== -1) {
          const result = { userId: userId, entitled: true, tier: 'tier3', expiresAt: Date.now() + PATREON_CACHE_TTL };
          patreonCache.set(accessToken, result);
          resolve(result);
          return;
        }

        const included = r.body.included || [];
        let entitled = false, tier = 'none';
        for (let i = 0; i < included.length; i++) {
          const it = included[i];
          if (it.type !== 'member') continue;
          const rel = it.relationships || {};
          const camp = rel.campaign && rel.campaign.data;
          if (!camp || camp.id !== PATREON_CAMPAIGN_ID) continue;
          const patronStatus = it.attributes && it.attributes.patron_status;
          const tierIds = ((rel.currently_entitled_tiers || {}).data || []).map(function(t) { return t.id; });
          if (patronStatus === 'active_patron') {
            if (tierIds.indexOf(PATREON_TIER3_ID) !== -1) { entitled = true; tier = 'tier3'; }
            else if (tierIds.indexOf(PATREON_TIER2_ID) !== -1) { entitled = true; tier = 'tier2'; }
          }
          break;
        }
        const result = { userId: userId, entitled: entitled, tier: tier, expiresAt: Date.now() + PATREON_CACHE_TTL };
        patreonCache.set(accessToken, result);
        resolve(result);
      })
      .catch(function(e) {
        console.error('[patreon] verify failed:', e.message);
        resolve({ userId: null, entitled: false, tier: 'none', expiresAt: Date.now() + 30000 });
      });
  });
}

// ── HTTP server ────────────────────────────────────────────────────────
function readJsonBody(req) {
  return new Promise(function(resolve, reject) {
    let chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, obj, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// Associate a SF user with a guild. Validates:
//   1. Patreon token is valid + user is Tier 2/3
//   2. Guild ID is a real guild the bot is in (Discord API call)
// Storage is in-memory — associations rebuild on SF re-connect anyway.
async function handleAssociate(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, { error: 'invalid_json' }, 400); }

  const { patreonAccessToken, guildId } = body || {};
  if (!patreonAccessToken || !guildId) return sendJson(res, { error: 'missing_fields' }, 400);

  const who = await verifyPatreon(patreonAccessToken);
  if (!who.entitled) return sendJson(res, { error: 'not_entitled', reason: who.reason || 'insufficient_tier' }, 403);

  // Verify the bot is in this guild — prevents typos from "claiming" a
  // server the bot never joined. This is a cheap REST call.
  let guildOk = false;
  try {
    const r = await fetch('https://discord.com/api/v10/guilds/' + encodeURIComponent(guildId), {
      headers: { 'Authorization': 'Bot ' + DISCORD_BOT_TOKEN, 'User-Agent': 'StreamFusion-bot' }
    });
    guildOk = r.ok;
  } catch (e) { /* fall through */ }
  if (!guildOk) return sendJson(res, { error: 'bot_not_in_guild' }, 404);

  // Bidirectional map.
  let subs = guildSubscribers.get(guildId);
  if (!subs) { subs = new Set(); guildSubscribers.set(guildId, subs); }
  subs.add(who.userId);

  return sendJson(res, { ok: true, tier: who.tier, userId: who.userId });
}

async function handleDisassociate(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, { error: 'invalid_json' }, 400); }

  const { patreonAccessToken, guildId } = body || {};
  if (!patreonAccessToken) return sendJson(res, { error: 'missing_fields' }, 400);

  const who = await verifyPatreon(patreonAccessToken);
  if (!who.userId) return sendJson(res, { error: 'unknown_user' }, 403);

  if (guildId) {
    const subs = guildSubscribers.get(guildId);
    if (subs) { subs.delete(who.userId); if (subs.size === 0) guildSubscribers.delete(guildId); }
  } else {
    // No guild — drop every association for this user.
    guildSubscribers.forEach(function(subs) { subs.delete(who.userId); });
  }
  return sendJson(res, { ok: true });
}

// Long-lived SSE stream. Auth + guild are passed as query params because
// EventSource (the browser + our app use the built-in one) can't set
// custom Authorization headers. The token never leaves the TLS channel.
async function handleEvents(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const patreonAccessToken = u.searchParams.get('token');
  if (!patreonAccessToken) { res.writeHead(401); res.end('missing token'); return; }

  const who = await verifyPatreon(patreonAccessToken);
  if (!who.entitled) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('not entitled (Patreon Tier 2 or Tier 3 required)');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  let conns = userConnections.get(who.userId);
  if (!conns) { conns = new Set(); userConnections.set(who.userId, conns); }
  const client = { res: res, patreonUserId: who.userId };
  conns.add(client);

  res.write('event: hello\ndata: ' + JSON.stringify({
    ok: true, tier: who.tier, userId: who.userId, botInvite: BOT_INVITE_URL
  }) + '\n\n');

  // Heartbeat every 25s so proxies / NAT boxes don't reap the connection.
  const hb = setInterval(function() {
    try { res.write(': hb\n\n'); } catch (e) {}
  }, 25000);

  req.on('close', function() {
    clearInterval(hb);
    conns.delete(client);
    if (conns.size === 0) userConnections.delete(who.userId);
  });
}

function handleHealth(res) {
  // Build a list of joined-guild summaries so operators can verify the
  // bot is actually a member of the server they expect. The /post-release
  // endpoint will fail with 403 if the target channel's server isn't in
  // this list — that's a common gotcha, so we surface it prominently.
  const guildList = [];
  joinedGuilds.forEach(function(info, gid) {
    guildList.push({ id: gid, name: info.name, memberCount: info.memberCount });
  });

  sendJson(res, {
    ok: true,
    gateway: ws && ws.readyState === WebSocket.OPEN,
    botUser: botUser ? {
      id: botUser.id,
      username: botUser.username,
      discriminator: botUser.discriminator
    } : null,
    // Guilds the bot is ACTUALLY a member of (via Discord Gateway).
    joinedGuildCount: joinedGuilds.size,
    joinedGuilds: guildList,
    // Guilds EA users have LINKED via /associate for event forwarding.
    // Kept under the old name too for backward compat with any older
    // monitoring scripts that might be polling this.
    subscribedGuildCount: guildSubscribers.size,
    guildCount: guildSubscribers.size,
    userCount: userConnections.size,
    botInvite: BOT_INVITE_URL
  });
}

// ── /post-release ───────────────────────────────────────────────────────
// Authenticated POST endpoint that the desktop-side release flow calls
// after publishing a new GitHub release. The bot formats a release-note
// embed + posts it to a configured Discord channel as itself.
//
// Request body (JSON):
//   {
//     "secret":      "<RELEASE_POST_SECRET>",
//     "channelId":   "1494765819891159202",
//     "version":     "1.5.0",
//     "title":       "StreamFusion 1.5.0",
//     "body":        "## Highlights ...",   // may be truncated to Discord's
//                                           //   4096-char embed.description limit
//     "url":         "https://github.com/.../releases/tag/v1.5.0",
//     "color":       0x3A86FF,              // optional — default SF blue
//     "pingRoleId":  "1486090420675936488"  // optional — Discord role ID to @ping
//                                           //   in the message content. Stable
//                                           //   release workflow passes the
//                                           //   "StreamFusion Updates" role;
//                                           //   beta workflow passes the
//                                           //   "Tier 3 Patron" role.
//   }
//
// Response: { ok: true, messageId } on success, { ok: false, error } on failure.
async function handlePostRelease(req, res) {
  const body = await readJsonBody(req).catch(function() { return null; });
  if (!body) { sendJson(res, { ok: false, error: 'bad_json' }, 400); return; }

  if (!RELEASE_POST_SECRET) {
    sendJson(res, { ok: false, error: 'disabled' }, 503);
    return;
  }
  if (body.secret !== RELEASE_POST_SECRET) {
    sendJson(res, { ok: false, error: 'unauthorized' }, 401);
    return;
  }
  const channelId = String(body.channelId || '').trim();
  if (!/^\d{15,25}$/.test(channelId)) {
    sendJson(res, { ok: false, error: 'invalid_channel_id' }, 400);
    return;
  }
  if (!DISCORD_BOT_TOKEN) {
    sendJson(res, { ok: false, error: 'no_bot_token' }, 500);
    return;
  }

  // Discord caps embed.description at 4096 chars. Truncate if longer so
  // we don't get 400s from the API. If somebody pastes a novel we give
  // them a link at the bottom pointing to the full release notes.
  const MAX = 4096;
  let desc = String(body.body || '');
  if (desc.length > MAX) desc = desc.slice(0, MAX - 80).replace(/\n[^\n]*$/, '') + '\n\n… [full notes on GitHub →](' + (body.url || '#') + ')';

  const embed = {
    title:       String(body.title || ('StreamFusion ' + (body.version || ''))).slice(0, 256),
    description: desc,
    url:         body.url || undefined,
    color:       typeof body.color === 'number' ? body.color : 0x3A86FF,
    timestamp:   new Date().toISOString(),
    footer:      { text: 'StreamFusion v' + (body.version || '?') }
  };

  // Role ping — only fires if a valid snowflake is passed. Role mentions
  // must live in `content` (not inside the embed), AND they must be
  // whitelisted in `allowed_mentions.roles` to actually ping, so we set
  // both. `parse: []` prevents any OTHER mention in the body from firing
  // accidentally (e.g. if someone puts @everyone in a release note).
  const payload = {
    embeds: [embed],
    allowed_mentions: { parse: [] }
  };
  const pingRoleId = body.pingRoleId ? String(body.pingRoleId).trim() : '';
  if (pingRoleId && /^\d{15,25}$/.test(pingRoleId)) {
    payload.content = '<@&' + pingRoleId + '>';
    payload.allowed_mentions = { parse: [], roles: [pingRoleId] };
  } else if (body.pingRoleId) {
    // Caller passed something but it wasn't a snowflake — log and drop
    // rather than silently posting without the ping.
    console.warn('[post-release] ignoring invalid pingRoleId:', body.pingRoleId);
  }

  try {
    const msg = await discordRest('POST', '/channels/' + channelId + '/messages', payload);
    if (msg && msg.id) {
      sendJson(res, { ok: true, messageId: msg.id, channelId: channelId });
    } else {
      sendJson(res, { ok: false, error: 'discord_no_id', response: msg }, 502);
    }
  } catch (err) {
    console.error('[post-release] discord REST error:', err && err.message);
    sendJson(res, { ok: false, error: String(err && err.message || err) }, 502);
  }
}

// Read a request's body as JSON. Resolves with the parsed object or
// rejects on timeout / invalid JSON / excessive size (cap at 128KB to
// reject accidental giant payloads).
function readJsonBody(req) {
  return new Promise(function(resolve, reject) {
    let chunks = [], total = 0;
    req.on('data', function(c) {
      total += c.length;
      if (total > 128 * 1024) { req.destroy(new Error('body_too_large')); return; }
      chunks.push(c);
    });
    req.on('end', function() {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
    setTimeout(function() { reject(new Error('timeout')); }, 10000);
  });
}

// Minimal Discord REST helper. Returns the parsed JSON response or
// throws on non-2xx. Only used for release-post right now, but kept
// generic so future bot features (reactions, edits) can share it.
function discordRest(method, path, bodyObj) {
  return new Promise(function(resolve, reject) {
    const https = require('https');
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = https.request({
      method: method,
      hostname: 'discord.com',
      path: '/api/v10' + path,
      headers: {
        'Authorization': 'Bot ' + DISCORD_BOT_TOKEN,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':    'StreamFusion-BotService (release-post, 1.0)'
      }
    }, function(res) {
      const chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + (json && json.message || text.slice(0, 200))));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const server = http.createServer(async function(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (req.method === 'GET'    && p === '/health')      { handleHealth(res); return; }
    if (req.method === 'GET'    && p === '/bot-invite')  {
      sendJson(res, { url: BOT_INVITE_URL });
      return;
    }
    if (req.method === 'GET'    && p === '/events')      { await handleEvents(req, res); return; }
    if (req.method === 'POST'   && p === '/associate')   { await handleAssociate(req, res); return; }
    if (req.method === 'DELETE' && p === '/associate')   { await handleDisassociate(req, res); return; }
    if (req.method === 'POST'   && p === '/post-release') { await handlePostRelease(req, res); return; }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error('[http] handler threw:', e);
    res.writeHead(500); res.end('internal error');
  }
});

server.listen(PORT, function() {
  console.log('[http] listening on :' + PORT);
  console.log('[http] bot invite URL:', BOT_INVITE_URL || '(not configured)');
  connectGateway();
  // Safety net: re-send presence every 10 minutes. Discord's presence
  // gossip can drift over long-lived Gateway connections and leave the
  // bot looking offline to some members while the socket is healthy.
  // sendGateway no-ops when the socket isn't OPEN, so this is safe
  // during reconnect windows too.
  setInterval(sendPresence, 10 * 60 * 1000);
});

process.on('SIGTERM', function() {
  isClosing = true;
  try { server.close(); } catch (e) {}
  try { if (ws) ws.close(1000, 'shutdown'); } catch (e) {}
  process.exit(0);
});
