// Discord integration — outbound webhooks + inbound Gateway bot.
//
// TWO MODES of communication:
//
//   1. Webhooks (outbound only). Simple HTTPS POST to a Discord webhook URL
//      that the streamer created in their Discord server. Used for:
//        - Stylized event posts (follows, subs, cheers, gifts, hype train)
//        - Stream records (cumulative highs per category)
//        - Stream recap posted at end of stream
//      No bot token needed. The streamer pastes a webhook URL into SF.
//
//   2. Bot Gateway (inbound). Persistent WebSocket to Discord's Gateway
//      so we can observe events happening in the streamer's server:
//        - Member joins (guild_member_add)
//        - Voice channel joins (voice_state_update)
//        - Message creation in a chosen channel (message_create)
//      These surface in SF's in-app Events panel so the streamer can
//      thank people without alt-tabbing to Discord. Requires the user
//      to register a Discord app, enable privileged intents, and invite
//      the bot to their server.
//
// All of this is EA-gated from main.js — the module itself doesn't check
// entitlement, but main.js only wires up the IPC handlers when the user
// is an active Tier 2/3 supporter.

'use strict';

const https = require('https');
const WebSocket = require('ws');

// ── CONFIG ──────────────────────────────────────────────────────────────
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Intent bitflags. Docs: https://discord.com/developers/docs/topics/gateway#gateway-intents
const INTENTS = {
  GUILDS:              1 << 0,
  GUILD_MEMBERS:       1 << 1,   // PRIVILEGED — must be toggled on in the dev portal
  GUILD_VOICE_STATES:  1 << 7,
  GUILD_MESSAGES:      1 << 9,
  MESSAGE_CONTENT:     1 << 15   // PRIVILEGED
};

// Gateway opcodes we care about.
const OP = {
  DISPATCH:              0,
  HEARTBEAT:             1,
  IDENTIFY:              2,
  RESUME:                6,
  RECONNECT:             7,
  INVALID_SESSION:       9,
  HELLO:                10,
  HEARTBEAT_ACK:        11
};

// ── State ───────────────────────────────────────────────────────────────
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let lastSequence = null;
let sessionId = null;
let resumeUrl = null;
let mainWindowRef = null;
let botConfig = null;     // { token, guildId, channelId, intents, onEvent }
let isConnecting = false;
let isClosing = false;

function setMainWindow(w) { mainWindowRef = w; }

// ── Webhook helpers ────────────────────────────────────────────────────

// postWebhook(url, payload) → Promise<{ok, status, body, id?}>
// - payload must be a valid Discord webhook payload object
// - ?wait=true is appended so Discord returns the created message, giving
//   us a message ID that records/recap use for delete-and-repost
function postWebhook(url, payload) {
  return new Promise(function(resolve) {
    if (!url) return resolve({ ok: false, status: 0, body: null, error: 'no_url' });
    var u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, status: 0, error: 'invalid_url' }); }
    // Add ?wait=true so the response includes the message body (including id)
    u.searchParams.set('wait', 'true');
    var body = JSON.stringify(payload || {});
    var req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || 443,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'StreamFusion-Discord (1.0)'
      }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: json || text,
          id: json && json.id
        });
      });
    });
    req.on('error', function(err) { resolve({ ok: false, status: 0, error: err.message }); });
    req.setTimeout(15000, function() { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// deleteWebhookMessage(url, messageId) → Promise<{ok, status}>
// Used by the records feature to wipe the previous records message before
// posting the new one, so the streamer's channel never fills with a stack
// of stale record embeds.
function deleteWebhookMessage(url, messageId) {
  return new Promise(function(resolve) {
    if (!url || !messageId) return resolve({ ok: false, error: 'missing' });
    var u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'invalid_url' }); }
    // Webhook URL pattern: /api/webhooks/{id}/{token}
    // To delete a specific message we append /messages/{messageId}
    var path = u.pathname.replace(/\/$/, '') + '/messages/' + encodeURIComponent(messageId);
    var req = https.request({
      method: 'DELETE',
      hostname: u.hostname,
      path: path,
      port: u.port || 443,
      headers: { 'User-Agent': 'StreamFusion-Discord (1.0)' }
    }, function(res) {
      res.on('data', function() {});
      res.on('end', function() {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
    });
    req.on('error', function(err) { resolve({ ok: false, error: err.message }); });
    req.setTimeout(10000, function() { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// ── Bot Gateway connection ─────────────────────────────────────────────

function emitEvent(kind, data) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    try { mainWindowRef.webContents.send('discord-event', { kind: kind, data: data }); } catch (e) {}
  }
  if (botConfig && typeof botConfig.onEvent === 'function') {
    try { botConfig.onEvent(kind, data); } catch (e) {}
  }
}

function sendGateway(op, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ op: op, d: data })); } catch (e) {
    console.error('[discord-bot] send failed:', e.message);
  }
}

function startHeartbeat(intervalMs) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // First heartbeat should fire at a random offset 0..interval per Discord
  // docs, so a cluster of clients that reconnect together doesn't stampede
  // the gateway. We use Math.random() * interval for the initial delay.
  setTimeout(function firstHb() {
    sendGateway(OP.HEARTBEAT, lastSequence);
    heartbeatTimer = setInterval(function() {
      sendGateway(OP.HEARTBEAT, lastSequence);
    }, intervalMs);
  }, Math.random() * intervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function identify() {
  if (!botConfig || !botConfig.token) return;
  sendGateway(OP.IDENTIFY, {
    token: botConfig.token,
    intents: botConfig.intents || (INTENTS.GUILDS | INTENTS.GUILD_MEMBERS | INTENTS.GUILD_VOICE_STATES),
    properties: {
      os:      process.platform,
      browser: 'StreamFusion',
      device:  'StreamFusion'
    }
  });
}

function resumeSession() {
  if (!botConfig || !sessionId || lastSequence == null) { identify(); return; }
  sendGateway(OP.RESUME, {
    token: botConfig.token,
    session_id: sessionId,
    seq: lastSequence
  });
}

function handleDispatch(eventName, data) {
  // The dispatch names that matter for our Events panel integration.
  // Everything else is ignored to keep the main window from being spammed
  // with internal gateway events.
  switch (eventName) {
    case 'READY':
      sessionId = data.session_id;
      resumeUrl = data.resume_gateway_url;
      emitEvent('ready', { user: data.user && data.user.username, guilds: (data.guilds || []).length });
      break;
    case 'GUILD_MEMBER_ADD':
      // Only surface if from the configured guild (if any). If no guild
      // is configured, pass through everything — the bot should only
      // be in one guild anyway for typical streamer use.
      if (!botConfig.guildId || data.guild_id === botConfig.guildId) {
        var u = data.user || {};
        emitEvent('member_add', {
          guildId: data.guild_id,
          userId: u.id,
          username: u.username || u.global_name || 'Unknown',
          displayName: data.nick || u.global_name || u.username,
          avatarHash: u.avatar
        });
      }
      break;
    case 'VOICE_STATE_UPDATE':
      // Fires on every join/leave/move. We only forward JOIN events
      // (i.e. state went from no-channel to a channel) so leavers and
      // channel-hops don't spam.
      if (botConfig.guildId && data.guild_id !== botConfig.guildId) break;
      if (!data.channel_id) break; // left voice
      emitEvent('voice_join', {
        guildId: data.guild_id,
        channelId: data.channel_id,
        userId: data.user_id,
        username: (data.member && data.member.user && (data.member.user.username || data.member.user.global_name)) || data.user_id
      });
      break;
    case 'MESSAGE_CREATE':
      // Only if the streamer configured a channel AND the message lands
      // there. We don't require MESSAGE_CONTENT intent by default; if
      // the user doesn't enable it, `content` will be empty string but
      // we still get sender metadata.
      if (botConfig.channelId && data.channel_id === botConfig.channelId) {
        var m = data.author || {};
        // Bots posting their own webhook messages would otherwise loop
        // back into the events panel as "new message". Filter them out.
        if (m.bot) break;
        emitEvent('message', {
          channelId: data.channel_id,
          userId: m.id,
          username: m.global_name || m.username || 'Unknown',
          content: data.content || '(no content — enable MESSAGE_CONTENT intent)'
        });
      }
      break;
    // Everything else — drop silently.
  }
}

function handleMessage(raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.s != null) lastSequence = msg.s;

  switch (msg.op) {
    case OP.HELLO:
      startHeartbeat(msg.d.heartbeat_interval);
      // If we have an existing session, try to resume; otherwise identify fresh.
      if (sessionId && lastSequence != null) resumeSession();
      else identify();
      break;
    case OP.HEARTBEAT:
      // Gateway asking us to heartbeat immediately
      sendGateway(OP.HEARTBEAT, lastSequence);
      break;
    case OP.HEARTBEAT_ACK:
      // No-op for us. We track latency elsewhere if ever needed.
      break;
    case OP.INVALID_SESSION:
      // Session is dead; gateway sends this with d = true/false indicating
      // whether session is resumable. We treat it as non-resumable for
      // safety (spec says false means can't resume; true might be
      // transient but mishandling it is worse than a single re-identify).
      sessionId = null;
      lastSequence = null;
      setTimeout(function() { identify(); }, 2000 + Math.random() * 3000);
      break;
    case OP.RECONNECT:
      // Gateway asking us to reconnect (likely for maintenance). Clean
      // close + let the close handler reconnect with the resume URL.
      try { ws.close(4000, 'gateway reconnect'); } catch (e) {}
      break;
    case OP.DISPATCH:
      handleDispatch(msg.t, msg.d);
      break;
  }
}

function connectSocket() {
  if (isConnecting) return;
  isConnecting = true;
  var url = resumeUrl ? (resumeUrl + '/?v=10&encoding=json') : GATEWAY_URL;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[discord-bot] ws construction failed:', e.message);
    isConnecting = false;
    scheduleReconnect();
    return;
  }
  ws.on('open', function() {
    isConnecting = false;
    emitEvent('gateway_connected', {});
  });
  ws.on('message', function(data) { handleMessage(data.toString()); });
  ws.on('error', function(err) {
    console.error('[discord-bot] ws error:', err && err.message);
  });
  ws.on('close', function(code, reason) {
    isConnecting = false;
    stopHeartbeat();
    emitEvent('gateway_closed', { code: code, reason: reason && reason.toString() });
    // Close codes 4004 (auth failed), 4010/4011 (bad shard/intents),
    // 4012/4013/4014 (api version / invalid intent / disallowed intent)
    // are unrecoverable — don't auto-reconnect or we'll loop forever.
    var unrecoverable = [4004, 4010, 4011, 4012, 4013, 4014];
    if (!isClosing && unrecoverable.indexOf(code) === -1 && botConfig) {
      scheduleReconnect();
    }
    if (unrecoverable.indexOf(code) !== -1) {
      emitEvent('fatal', { code: code, reason: reason && reason.toString() });
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer || isClosing) return;
  // Simple fixed-ish backoff with jitter. Discord recommends exponential
  // backoff but since we're a single client talking to their gateway,
  // a capped random delay is fine.
  var delay = 5000 + Math.random() * 5000;
  reconnectTimer = setTimeout(function() {
    reconnectTimer = null;
    connectSocket();
  }, delay);
}

function connectBot(cfg) {
  // cfg: { token, guildId?, channelId?, intents?, onEvent? }
  if (!cfg || !cfg.token) return Promise.resolve({ ok: false, reason: 'no_token' });
  if (botConfig && ws && ws.readyState === WebSocket.OPEN) {
    // Already connected — rotate the config but don't reconnect.
    botConfig = Object.assign({}, botConfig, cfg);
    return Promise.resolve({ ok: true, reason: 'already_connected' });
  }
  botConfig = cfg;
  isClosing = false;
  connectSocket();
  return Promise.resolve({ ok: true, reason: 'connecting' });
}

function disconnectBot() {
  isClosing = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHeartbeat();
  if (ws) {
    try { ws.close(1000, 'bye'); } catch (e) {}
    ws = null;
  }
  botConfig = null;
  sessionId = null;
  lastSequence = null;
  resumeUrl = null;
  return Promise.resolve({ ok: true });
}

function getBotStatus() {
  return {
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    hasConfig: !!botConfig,
    sessionId: sessionId,
    lastSequence: lastSequence
  };
}

module.exports = {
  postWebhook:          postWebhook,
  deleteWebhookMessage: deleteWebhookMessage,
  connectBot:           connectBot,
  disconnectBot:        disconnectBot,
  getBotStatus:         getBotStatus,
  setMainWindow:        setMainWindow,
  INTENTS:              INTENTS
};
